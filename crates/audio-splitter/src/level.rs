/// 조각 안의 말소리 크기를 맞춘다 — 조각 전체에 같은 게인을 곱해 문장 안의 강약은 그대로 둔다.
/// whisper 의 log-mel 은 절대 크기 기준이라 작게 녹음된 파일은 인식률이 크게 떨어진다.
const FRAME_MS: usize = 100;
/// 말소리 큰 쪽(프레임 RMS 상위 5%)을 이 크기에 맞춘다
const TARGET_DB: f32 = -20.0;
/// 키울 수 있는 상한
const MAX_GAIN_DB: f32 = 42.0;
/// 샘플 최대값 상한 — PCM16 에서 잘리지 않게 한다
const PEAK_LIMIT: f32 = 0.95;
/// 프레임 크기 변화폭이 이보다 작으면 말소리 없는 잡음으로 보고 키우지 않는다
const MIN_RANGE_DB: f32 = 10.0;

pub fn normalize(samples: &mut [f32], rate: u32) {
    let frame = rate as usize * FRAME_MS / 1000;
    if samples.len() < frame {
        return;
    }
    let mut frames: Vec<f32> = samples.chunks_exact(frame).map(crate::splitter::rms_db).collect();
    frames.sort_by(|a, b| a.total_cmp(b));
    let loud = frames[(frames.len() - 1) * 95 / 100];
    let quiet = frames[(frames.len() - 1) * 20 / 100];
    if loud - quiet < MIN_RANGE_DB {
        return;
    }
    let peak = samples.iter().fold(0f32, |max, s| max.max(s.abs()));
    let gain = 10f32.powf((TARGET_DB - loud).clamp(0.0, MAX_GAIN_DB) / 20.0).min(PEAK_LIMIT / peak.max(1e-9));
    if gain > 1.0 {
        samples.iter_mut().for_each(|s| *s *= gain);
    }
}