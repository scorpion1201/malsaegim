"""한국어 평가셋 만들기 — HF 데이터셋(parquet)에서 발화를 골라 16 kHz WAV 와 정답(refs.jsonl)으로 풀어 놓는다.

음성·전사문은 저장소에 넣지 않는다(라이선스: Zeroth-Korean 은 CC BY 4.0, KsponSpeech·AI Hub 방언 미러는
원 약관상 재배포 금지라 승인된 사용자가 로컬 평가에만 쓴다). 결과 디렉터리는 저장소 밖에 둔다.

    python3 -I scripts/eval/prepare.py zeroth   /tmp/eval/zeroth   --n 40
    python3 -I scripts/eval/prepare.py kspon    /tmp/eval/kspon    --n 40
    python3 -I scripts/eval/prepare.py jeju     /tmp/eval/jeju     --n 40   # 분할 zip 에서 필요한 파일만 HTTP Range 로 꺼낸다

필요: pip install pyarrow soundfile numpy
"""
import argparse
import io
import json
import os
import struct
import urllib.request
import zlib

# 평가셋 출처 — 리비전을 고정해 같은 발화로 다시 잴 수 있게 한다
SOURCES = {
    # 낭독체 (CC BY 4.0)
    'zeroth': {
        'repo': 'kresnik/zeroth_korean',
        'revision': '1fe937899f828af822293d05e086200946088bdf',
        'file': 'data/test-00000-of-00001.parquet',
        'text': 'text',
    },
    # 자유 대화 — 말 더듬기·간투사·비유창 발화가 많다 (KsponSpeech eval_other 미러, AI Hub 약관)
    'kspon': {
        'repo': 'Kyudan/KsponSpeech_eval_other',
        'revision': '6e6ec517f71bbc59fe7556e131ac253bf699d145',
        'file': 'data/train-00000-of-00005.parquet',
        'text': 'text',
    },
    # 제주 방언 (AI Hub 한국어 방언 발화(제주도) 미러) — 59 GB 분할 zip 이라 Range 로 일부만 꺼낸다
    'jeju': {
        'repo': 'Mireu-Lab/Korean-jeju-dialect-speech',
        'revision': 'eed321c47983e2313e6742b80872338d62eb196b',
    },
}

HF = 'https://huggingface.co/datasets/{repo}/resolve/{revision}/{path}'


def fetch(url, start=None, end=None):
    request = urllib.request.Request(url)
    if start is not None:
        request.add_header('Range', f'bytes={start}-{end}')
    with urllib.request.urlopen(request) as response:
        return response.read()


def head_size(url):
    request = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(request) as response:
        return int(response.headers['Content-Length'])


def write_set(out, rows):
    import numpy as np
    import soundfile as sf

    os.makedirs(os.path.join(out, 'wav'), exist_ok=True)
    with open(os.path.join(out, 'refs.jsonl'), 'w', encoding='utf-8') as refs:
        for row in rows:
            audio, rate = sf.read(io.BytesIO(row['audio']), dtype='float32', always_2d=False)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if rate != 16000:
                # 선형 보간 리샘플 — 평가용(모델 비교)으로 충분하다
                n = int(round(len(audio) * 16000 / rate))
                audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype('float32')
            path = os.path.join(out, 'wav', f"{row['id']}.wav")
            sf.write(path, audio, 16000, subtype='PCM_16')
            ref = {'id': row['id'], 'wav': path, 'text': row['text'], 'sec': len(audio) / 16000}
            if row.get('standard'):
                ref['standard'] = row['standard']
            refs.write(json.dumps(ref, ensure_ascii=False) + '\n')


def from_parquet(source, n):
    import pyarrow.parquet as pq

    data = fetch(HF.format(repo=source['repo'], revision=source['revision'], path=source['file']))
    table = pq.read_table(io.BytesIO(data)).to_pylist()
    step = max(1, len(table) // n)
    rows = []
    for index, row in enumerate(table[::step][:n]):
        name = row.get('id') or os.path.splitext(os.path.basename(row.get('original_audio_path') or f'{index}'))[0]
        rows.append({'id': str(name), 'audio': row['audio']['bytes'], 'text': row[source['text']]})
    return rows


def zip_central_directory(url):
    """분할 zip 의 마지막 조각(.zip)에서 중앙 디렉터리를 읽는다 (ZIP64 포함)"""
    size = head_size(url)
    tail = fetch(url, max(0, size - 65536 - 22), size - 1)
    eocd = tail.rfind(b'PK\x05\x06')
    _, disk, cd_disk, _, entries, cd_size, cd_offset = struct.unpack('<IHHHHII', tail[eocd:eocd + 20])
    if cd_offset == 0xFFFFFFFF or entries == 0xFFFF:
        locator = tail.rfind(b'PK\x06\x07')
        _, z64_disk, z64_offset, _ = struct.unpack('<IIQI', tail[locator:locator + 20])
        record = fetch(url, z64_offset, z64_offset + 55) if z64_disk == disk else None
        if record is None:
            raise RuntimeError('ZIP64 레코드가 다른 조각에 있습니다')
        _, _, _, _, disk, cd_disk, _, entries, cd_size, cd_offset = struct.unpack('<IQHHIIQQQQ', record[:56])
    if cd_disk != disk:
        raise RuntimeError('중앙 디렉터리가 마지막 조각에 없습니다')
    directory = fetch(url, cd_offset, cd_offset + cd_size - 1)
    files, pos = [], 0
    while pos < len(directory) and directory[pos:pos + 4] == b'PK\x01\x02':
        (method, csize, usize, name_len, extra_len, comment_len, disk_start, local) = (
            struct.unpack('<H', directory[pos + 10:pos + 12])[0],
            *struct.unpack('<II', directory[pos + 20:pos + 28]),
            *struct.unpack('<HHHH', directory[pos + 28:pos + 36]),
            struct.unpack('<I', directory[pos + 42:pos + 46])[0],
        )
        name = directory[pos + 46:pos + 46 + name_len].decode('utf-8', 'replace')
        extra = directory[pos + 46 + name_len:pos + 46 + name_len + extra_len]
        # ZIP64 확장 필드: 0xFFFFFFFF 인 값만 순서대로 들어 있다
        e = 0
        while e + 4 <= len(extra):
            tag, length = struct.unpack('<HH', extra[e:e + 4])
            if tag == 1:
                body, k = extra[e + 4:e + 4 + length], 0
                if usize == 0xFFFFFFFF:
                    usize = struct.unpack('<Q', body[k:k + 8])[0]; k += 8
                if csize == 0xFFFFFFFF:
                    csize = struct.unpack('<Q', body[k:k + 8])[0]; k += 8
                if local == 0xFFFFFFFF:
                    local = struct.unpack('<Q', body[k:k + 8])[0]; k += 8
                if disk_start == 0xFFFF:
                    disk_start = struct.unpack('<I', body[k:k + 4])[0]
            e += 4 + length
        files.append({'name': name, 'method': method, 'csize': csize, 'disk': disk_start, 'offset': local})
        pos += 46 + name_len + extra_len + comment_len
    return files, disk


def zip_member(part_url, entry):
    header = fetch(part_url, entry['offset'], entry['offset'] + 29)
    name_len, extra_len = struct.unpack('<HH', header[26:30])
    start = entry['offset'] + 30 + name_len + extra_len
    data = fetch(part_url, start, start + entry['csize'] - 1)
    if entry['method'] == 0:
        return data
    if entry['method'] == 8:
        return zlib.decompress(data, -15)
    raise RuntimeError(f"지원하지 않는 압축 방식 {entry['method']}")


def from_jeju(source, n, conversations=6):
    """대화 녹음(파일 하나 = 대화 전체)에서 방언 어절이 든 발화를 라벨 시각으로 잘라 쓴다. 정답은 들리는 대로의 방언형"""
    import zipfile

    import numpy as np
    import soundfile as sf

    base = 'https://huggingface.co/datasets/{repo}/resolve/{revision}/Archives/'.format(**source)
    audio_files, last_disk = zip_central_directory(base + 'Audio.zip')
    by_stem = {os.path.splitext(os.path.basename(f['name']))[0]: f for f in audio_files if f['name'].lower().endswith('.wav')}
    with zipfile.ZipFile(io.BytesIO(fetch(base + 'Text.zip'))) as archive:
        labels = [json.loads(archive.read(name).decode('utf-8-sig')) for name in sorted(archive.namelist()) if name.endswith('.json')]
    # 작은 녹음부터 몇 개만 받는다 (파일 하나가 수십 MB~수백 MB)
    labels = [label for label in labels if label['id'] in by_stem]
    labels.sort(key=lambda label: by_stem[label['id']]['csize'])
    per_file = max(1, -(-n // conversations))
    rows = []
    for label in labels[:conversations]:
        entry = by_stem[label['id']]
        part = 'Audio.zip' if entry['disk'] == last_disk else f"Audio.z{entry['disk'] + 1:02d}"
        audio, rate = sf.read(io.BytesIO(zip_member(base + part, entry)), dtype='float32', always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        picked = [
            u for u in label['utterance']
            if 2.0 <= u['end'] - u['start'] <= 20.0 and any(e.get('isDialect') for e in u.get('eojeolList', [])) and '(())' not in u['form']
        ]
        step = max(1, len(picked) // per_file)
        for u in picked[::step][:per_file]:
            segment = audio[int(u['start'] * rate):int(u['end'] * rate)]
            buffer = io.BytesIO()
            sf.write(buffer, segment, rate, format='WAV', subtype='PCM_16')
            rows.append({'id': u['id'], 'audio': buffer.getvalue(), 'text': u['dialect_form'], 'standard': u['standard_form']})
    return rows[:n]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', choices=sorted(SOURCES))
    parser.add_argument('out')
    parser.add_argument('--n', type=int, default=40)
    args = parser.parse_args()
    source = SOURCES[args.source]
    rows = from_jeju(source, args.n) if args.source == 'jeju' else from_parquet(source, args.n)
    write_set(args.out, rows)
    print(f'{args.source}: {len(rows)} utterances → {args.out}')