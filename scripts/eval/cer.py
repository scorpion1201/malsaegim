"""한국어 CER 평가 — prepare.py 로 만든 평가셋을 whisper.cpp(whisper-cli)로 인식해 모델별 글자 오류율을 낸다.

앱(wasm)과 같은 ggml 모델·같은 디코딩 설정(한국어 고정, greedy, 온도 폴백 없음, 문맥 이월 없음, 타임스탬프 모드)으로 돌린다.
-nt 는 출력만 끄는 옵션이 아니라 프롬프트에 <|notimestamps|> 를 넣어 결과를 바꾸므로 쓰지 않는다 (앱은 no_timestamps 를 켜지 않는다).
네이티브 CPU 로 돌리므로 정확도 비교용이다 — 속도는 wasm 과 다르니 성능 수치로 쓰지 않는다.

    python3 -I scripts/eval/cer.py --cli <whisper.cpp>/build/bin/whisper-cli \\
        --model turbo=<ggml-large-v3-turbo-q8_0.bin> --model small=<ggml-small-q8_0.bin> \\
        --set zeroth=/tmp/eval/zeroth --set kspon=/tmp/eval/kspon --out /tmp/eval/report.json
"""
import argparse
import json
import os
import re
import subprocess
import unicodedata

# 비교 전에 지우는 것: 문장부호·기호·공백 (한국어 CER 은 띄어쓰기를 빼고 센다)
PUNCT = re.compile(r'[\s.,?!…~"\'“”‘’·、。:;()\[\]{}<>«»\-–—/\\|*#%&^_=+@`]')
# 전사 규칙의 이중 표기 (A)/(B) — KsponSpeech 는 (철자)/(발음), AI Hub 방언은 (방언)/(표준어). 앞(실제 표기·들리는 말)을 쓴다
DUAL = re.compile(r'\(([^)/]*)\)/\(([^)]*)\)')
# 잡음 표기(b/ n/ o/ l/ u/), 알아듣지 못한 구간 (()) , 비식별 표시(*, &name&, #name), 비언어 표기 {laughing} 을 지운다
NOISE = re.compile(r"\b[bnolu]/|\(\([^)]*\)\)|\*|\{[^}]*\}|&[^&]*&|[#@][a-z0-9]*")


def normalize(text):
    text = unicodedata.normalize('NFKC', text)
    text = DUAL.sub(r'\1', text)
    text = NOISE.sub('', text)
    return PUNCT.sub('', text).lower()


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def transcribe(cli, model, wav, threads):
    result = subprocess.run(
        [cli, '-m', model, '-f', wav, '-l', 'ko', '-t', str(threads), '-bs', '1', '-bo', '1', '-nf', '-sns', '-mc', '0', '-np'],
        capture_output=True, text=True, check=True,
    )
    return ' '.join(re.sub(r'^\[[^\]]*\]', '', line).strip() for line in result.stdout.splitlines() if line.strip())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli', required=True)
    parser.add_argument('--model', action='append', required=True, help='이름=ggml 경로')
    parser.add_argument('--set', action='append', required=True, help='이름=prepare.py 출력 디렉터리')
    parser.add_argument('--threads', type=int, default=os.cpu_count() or 4)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    models = dict(item.split('=', 1) for item in args.model)
    sets = dict(item.split('=', 1) for item in args.set)

    report = {'models': models, 'sets': {}, 'rows': []}
    for set_name, directory in sets.items():
        with open(os.path.join(directory, 'refs.jsonl'), encoding='utf-8') as refs:
            items = [json.loads(line) for line in refs if line.strip()]
        summary = {}
        for model_name, model_path in models.items():
            errors = chars = 0
            for item in items:
                hyp = transcribe(args.cli, model_path, item['wav'], args.threads)
                ref_n, hyp_n = normalize(item['text']), normalize(hyp)
                distance = edit_distance(ref_n, hyp_n)
                errors += distance
                chars += len(ref_n)
                report['rows'].append({'set': set_name, 'model': model_name, 'id': item['id'], 'ref': item['text'], 'hyp': hyp, 'errors': distance, 'chars': len(ref_n)})
            summary[model_name] = {'cer': round(errors / max(1, chars), 4), 'errors': errors, 'chars': chars, 'utterances': len(items)}
            print(f'{set_name:10s} {model_name:10s} CER {summary[model_name]["cer"] * 100:6.2f}%  ({errors}/{chars}, {len(items)} utt)')
        report['sets'][set_name] = summary
    with open(args.out, 'w', encoding='utf-8') as out:
        json.dump(report, out, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()