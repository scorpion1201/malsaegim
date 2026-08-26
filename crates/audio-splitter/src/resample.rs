use std::f32::consts::PI;

/// 모노 f32 스트리밍 리샘플러 (윈도우드 싱크, 한쪽 탭 수 HALF_TAPS).
/// 출력 k번째 샘플의 입력 위치를 정수 비율 k·in/out 로 매번 계산하므로 누적 오차가 없고,
/// 입력을 여러 번 `process` 해도 한 번에 넣은 것과 같은 결과를 낸다.
pub struct Resampler {
    in_rate: u64,
    out_rate: u64,
    cutoff: f32,    // 정규화 컷오프 (다운샘플 시 out/in, 아니면 1.0)
    buf: Vec<f32>, // buf[j] 의 절대 입력 인덱스 = base + j
    base: i64,
    k: u64,         // 다음 출력 샘플 번호
    passthrough: bool,
}

const HALF_TAPS: usize = 16;

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let ratio = out_rate as f32 / in_rate as f32;
        Self {
            in_rate: in_rate as u64,
            out_rate: out_rate as u64,
            cutoff: ratio.min(1.0),
            buf: vec![0.0; HALF_TAPS], // 절대 인덱스 -HALF_TAPS..0 은 0으로 패딩
            base: -(HALF_TAPS as i64),
            k: 0,
            passthrough: in_rate == out_rate,
          }
      }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(input);
            return;
          }
        self.buf.extend_from_slice(input);
        self.drain(out);
      }

      /// 스트림 끝: 제로 패딩으로 남은 샘플까지 출력한다. 이후 process 호출 금지.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        if self.passthrough {
            return;
          }
        self.buf.extend(std::iter::repeat(0.0).take(HALF_TAPS));
        self.drain(out);
      }

      /// 출력 k의 입력 위치: 정수부(절대 인덱스)와 소수부.
    fn position(&self, k: u64) -> (i64, f32) {
        let num = k * self.in_rate;
          ((num / self.out_rate) as i64, (num % self.out_rate) as f32 / self.out_rate as f32)
      }

    fn drain(&mut self, out: &mut Vec<f32>) {
        let len = self.buf.len() as i64;
        loop {
            let (idx_abs, frac) = self.position(self.k);
            let j = idx_abs - self.base; // buf 안에서의 정수 위치
            if j + HALF_TAPS as i64 >= len {
                break;
              }
            out.push(self.sample_at(j as usize, frac));
            self.k += 1;
          }
          // 다음 출력에 더 이상 필요 없는 앞부분을 버린다.
        let (idx_abs, _) = self.position(self.k);
        let keep_from = idx_abs - self.base - HALF_TAPS as i64;
        if keep_from > 0 {
            self.buf.drain(..keep_from as usize);
            self.base += keep_from;
          }
      }

    fn sample_at(&self, j: usize, frac: f32) -> f32 {
        let mut acc = 0.0f32;
        for i in (j + 1 - HALF_TAPS)..=(j + HALF_TAPS) {
            let d = (i as f32 - j as f32) - frac;
            acc += self.buf[i] * self.kernel(d);
          }
        acc
      }

    fn kernel(&self, d: f32) -> f32 {
        let x = d * self.cutoff;
        let sinc = if x.abs() < 1e-6 { 1.0 } else { (PI * x).sin() / (PI * x) };
        let w = 0.5 + 0.5 * (PI * d / HALF_TAPS as f32).cos(); // Hann
        self.cutoff * sinc * w
      }
}