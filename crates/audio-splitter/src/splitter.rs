/// 16kHz 모노 f32 스트림을 무음 경계에서 잘라 조각으로 낸다.
#[derive(Clone, Copy, Debug)]
pub struct SplitConfig {
    pub target_secs: f32,
    pub max_secs: f32,
    pub silence_db: f32,
}

#[derive(Debug, PartialEq)]
pub struct Chunk {
    pub index: u32,
    pub start_ms: f64,
    pub end_ms: f64,
    pub samples: Vec<f32>,
}

pub struct Splitter {
    cfg: SplitConfig,
    rate: u32,
    buf: Vec<f32>,
    emitted_samples: u64,
    next_index: u32,
}

const FRAME_MS: usize = 20;
const SEARCH_BACK_SECS: f32 = 20.0;
/// 무음 문턱은 창의 잡음 바닥(하위 10% 프레임)에서 이만큼 위를 넘지 않는다 — 작게 녹음된 파일은 전 구간이 silence_db 아래다
const FLOOR_MARGIN_DB: f32 = 10.0;

impl Splitter {
    pub fn new(cfg: SplitConfig, rate: u32) -> Self {
        Self { cfg, rate, buf: Vec::new(), emitted_samples: 0, next_index: 0 }
    }

    /// 샘플을 넣고, 상한(max_secs)만큼 쌓일 때마다 경계를 골라 조각을 낸다.
    pub fn push(&mut self, samples: &[f32], emit: &mut impl FnMut(Chunk)) {
        self.buf.extend_from_slice(samples);
        let max_len = (self.cfg.max_secs * self.rate as f32) as usize;
        while self.buf.len() >= max_len {
            let cut = self.choose_boundary(max_len);
            self.emit_prefix(cut, emit);
        }
    }

    /// 스트림 끝: 남은 샘플을 마지막 조각으로 낸다.
    pub fn finish(mut self, emit: &mut impl FnMut(Chunk)) {
        if !self.buf.is_empty() {
            let len = self.buf.len();
            self.emit_prefix(len, emit);
        }
    }

    fn emit_prefix(&mut self, cut: usize, emit: &mut impl FnMut(Chunk)) {
        let samples: Vec<f32> = self.buf.drain(..cut).collect();
        let start_ms = self.emitted_samples as f64 * 1000.0 / self.rate as f64;
        self.emitted_samples += cut as u64;
        let end_ms = self.emitted_samples as f64 * 1000.0 / self.rate as f64;
        let chunk = Chunk { index: self.next_index, start_ms, end_ms, samples };
        self.next_index += 1;
        emit(chunk);
    }

    /// [max(target - 20s, max/2), max] 창의 가장 긴 무음 구간의 중앙. 없으면 RMS 최소 프레임. 그것도 없으면 max.
    fn choose_boundary(&self, max_len: usize) -> usize {
        let frame = self.rate as usize * FRAME_MS / 1000;
        let target = (self.cfg.target_secs * self.rate as f32) as usize;
        // 창 시작은 max_len/2 아래로 내려가지 않는다 — 조각이 너무 짧아지거나 0으로 잘리는 것 방지.
        let win_start = target
            .saturating_sub((SEARCH_BACK_SECS * self.rate as f32) as usize)
            .max(max_len / 2);
        let win_end = max_len.min(self.buf.len());
        if win_end <= win_start + frame {
            return max_len;
        }
        let frames: Vec<(usize, f32)> = (win_start..win_end - frame)
            .step_by(frame)
            .map(|s| (s, rms_db(&self.buf[s..s + frame])))
            .collect();
        let mut levels: Vec<f32> = frames.iter().map(|(_, db)| *db).collect();
        levels.sort_by(|a, b| a.total_cmp(b));
        let threshold = self.cfg.silence_db.min(levels[levels.len() / 10] + FLOOR_MARGIN_DB);

        // 가장 긴 무음 런
        let mut best: Option<(usize, usize)> = None; // (run_start_frame_idx, run_len)
        let mut run_start = None;
        for (i, (_, db)) in frames.iter().enumerate() {
            if *db <= threshold {
                if run_start.is_none() {
                    run_start = Some(i);
                }
                let len = i + 1 - run_start.unwrap();
                if best.map_or(true, |(_, l)| len > l) {
                    best = Some((run_start.unwrap(), len));
                }
            } else {
                run_start = None;
            }
        }
        if let Some((start_i, len)) = best {
            let mid = start_i + len / 2;
            return frames[mid].0;
        }
        // 무음 없음: RMS 최소 프레임
        frames
            .iter()
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .map(|(s, _)| *s)
            .unwrap_or(max_len)
    }
}

pub fn rms_db(x: &[f32]) -> f32 {
    let rms = (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
    20.0 * (rms.max(1e-9)).log10()
}