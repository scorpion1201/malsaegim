use crate::decode;
use crate::resample::Resampler;

const OUT_RATE: u32 = 16_000;

/// 추출할 시간 구간. `end_sample == u64::MAX` 는 "스트림 끝까지"(마지막 조각 규칙).
#[derive(Clone, Copy, Debug)]
pub struct RangeSpec {
    pub index: u32,
    pub start_sample: u64,
    pub end_sample: u64,
}

impl RangeSpec {
    pub fn from_ms(index: u32, start_ms: f64, end_ms: Option<f64>) -> Self {
        Self {
            index,
            start_sample: (start_ms * OUT_RATE as f64 / 1000.0).round() as u64,
            end_sample: end_ms
                .map(|ms| (ms * OUT_RATE as f64 / 1000.0).round() as u64)
                .unwrap_or(u64::MAX),
        }
    }
}

/// 오디오를 디코드→16kHz 모노로 만든 뒤, 요청된 구간들의 샘플만 순서대로 잘라 `emit` 에 넘긴다.
/// 구간은 시작 샘플 기준 오름차순으로 처리되며(내부에서 정렬), 서로 겹치지 않는다고 가정한다.
/// 스트림이 구간 시작 전에 끝나면 그 구간은 emit 되지 않는다(호출 쪽에서 실패 유지로 처리).
/// 반환값: 스트림 총 길이(ms) — 저장된 durationMs 와의 드리프트 비교용.
pub fn extract_ranges_pcm(
    data: Vec<u8>,
    ranges: &[RangeSpec],
    emit: &mut impl FnMut(u32, f64, f64, Vec<f32>),
) -> Result<f64, String> {
    let mut sorted: Vec<RangeSpec> = ranges.to_vec();
    sorted.sort_by_key(|r| r.start_sample);

    let mut resampler: Option<Resampler> = None;
    let mut resampled: Vec<f32> = Vec::new();
    let mut pos: u64 = 0; // 지금까지 내보낸 16kHz 샘플 수 (다음 배치의 절대 시작 위치)
    let mut ri: usize = 0; // 현재(다음) 구간 인덱스
    let mut buf: Vec<f32> = Vec::new();

    let consume = |batch: &[f32], pos: &mut u64, ri: &mut usize, buf: &mut Vec<f32>, emit: &mut dyn FnMut(u32, f64, f64, Vec<f32>)| {
        let batch_start = *pos;
        let batch_end = batch_start + batch.len() as u64;
        while *ri < sorted.len() {
            let range = sorted[*ri];
            if batch_end <= range.start_sample {
                break; // 이 배치는 아직 구간 앞
            }
            let from = range.start_sample.max(batch_start);
            let to = range.end_sample.min(batch_end);
            if from < to {
                let a = (from - batch_start) as usize;
                let b = (to - batch_start) as usize;
                buf.extend_from_slice(&batch[a..b]);
            }
            if range.end_sample <= batch_end {
                // 구간 완료 → 방출하고 다음 구간으로
                let start_ms = range.start_sample as f64 * 1000.0 / OUT_RATE as f64;
                let end_ms = range.end_sample as f64 * 1000.0 / OUT_RATE as f64;
                emit(range.index, start_ms, end_ms, std::mem::take(buf));
                *ri += 1;
            } else {
                break; // 구간이 다음 배치로 이어짐
            }
        }
        *pos = batch_end;
    };

    decode::decode_audio(data, &mut |info, pcm| {
        let r = resampler.get_or_insert_with(|| Resampler::new(info.sample_rate, OUT_RATE));
        resampled.clear();
        r.process(pcm, &mut resampled);
        consume(&resampled, &mut pos, &mut ri, &mut buf, emit);
    })?;

    if let Some(r) = resampler.as_mut() {
        resampled.clear();
        r.flush(&mut resampled);
        consume(&resampled, &mut pos, &mut ri, &mut buf, emit);
    }

    // 스트림 끝: "끝까지" 구간(또는 저장된 end 가 실제 길이보다 긴 구간)을 실제 끝에서 마감
    let total_ms = pos as f64 * 1000.0 / OUT_RATE as f64;
    if ri < sorted.len() {
        let range = sorted[ri];
        if !buf.is_empty() {
            let start_ms = range.start_sample as f64 * 1000.0 / OUT_RATE as f64;
            emit(range.index, start_ms, total_ms, std::mem::take(&mut buf));
        }
    }
    Ok(total_ms)
}