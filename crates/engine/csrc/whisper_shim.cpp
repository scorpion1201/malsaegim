// 말새김 whisper.cpp 브리지 — whisper.h 의 구조체 많은 API 를 Rust 가 부르기 쉬운 C 함수로 감싼다.
// 실제 전사는 whisper.cpp(멀티스레드)가 하고, 세그먼트를 모아 두면 Rust(malsaegim-engine)가 정리해 텍스트로 만든다.
// 토큰 타임스탬프로 30초 패딩(무음) 위 토큰을 잘라 내는 것은 여기서(예전 emscripten.cpp 와 동일).
// 실시간 모드는 같은 컨텍스트로 짧은 창을 반복 인식하고, 확정 판단에 쓸 단어(어절)별 시각을 함께 모은다.
#include "whisper.h"
#include "ggml-backend.h"

#include <cstdio>
#include <string>
#include <vector>
#include <algorithm>

static whisper_context * g_ctx = nullptr;
static long long g_audio_ms = 0;
static const long long PAD_MARGIN_MS = 300;
static const size_t LOAD_BUFFER_BYTES = 16u << 20;
// 인식에 쓰는 GPU 장치 이름 (WebGPU 빌드에서 어댑터를 얻었을 때). 비어 있으면 CPU
static std::string g_gpu_name;

struct Seg { long long t0; long long t1; float nsp; float avg_logprob; std::string text; };
// 어절 하나 — BPE 토큰은 UTF-8 중간에서 끊길 수 있어 바이트로 이어 붙이고, 공백으로 시작하는 토큰에서 나눈다
struct Word { long long t0; long long t1; int seg; std::string text; };
static std::vector<Seg> g_segs;
static std::vector<Word> g_words;

static void on_progress(struct whisper_context *, struct whisper_state *, int progress, void *) {
    printf("PROG\t%d\n", progress);
    fflush(stdout);
}

static void on_segment(struct whisper_context * ctx, struct whisper_state *, int n_new, void *) {
    const int n = whisper_full_n_segments(ctx);
    const whisper_token eot = whisper_token_eot(ctx);
    for (int i = n - n_new; i < n; ++i) {
        std::string text;
        double logprob_sum = 0.0;
        int logprob_count = 0;
        const int seg_index = (int) g_segs.size();
        Word word{0, 0, seg_index, ""};
        const int n_tokens = whisper_full_n_tokens(ctx, i);
        for (int j = 0; j < n_tokens; ++j) {
            const whisper_token_data td = whisper_full_get_token_data(ctx, i, j);
            if (td.id >= eot) continue;
            if ((long long) td.t0 * 10 > g_audio_ms + PAD_MARGIN_MS) break;
            const char * piece = whisper_full_get_token_text(ctx, i, j);
            text += piece;
            logprob_sum += td.plog;
            logprob_count += 1;
            if (piece[0] == ' ' && !word.text.empty()) {
                g_words.push_back(word);
                word = Word{0, 0, seg_index, ""};
            }
            if (word.text.empty()) word.t0 = (long long) td.t0 * 10;
            word.t1 = (long long) td.t1 * 10;
            word.text += piece;
        }
        if (!word.text.empty()) g_words.push_back(word);
        std::replace(text.begin(), text.end(), '\n', ' ');
        std::replace(text.begin(), text.end(), '\t', ' ');
        Seg s;
        s.t0 = (long long) whisper_full_get_segment_t0(ctx, i) * 10;
        s.t1 = (long long) whisper_full_get_segment_t1(ctx, i) * 10;
        s.nsp = whisper_full_get_segment_no_speech_prob(ctx, i);
        s.avg_logprob = logprob_count > 0 ? (float) (logprob_sum / logprob_count) : 0.0f;
        s.text = text;
        g_segs.push_back(s);
    }
}

extern "C" {

// use_gpu != 0: GPU 백엔드(WebGPU 빌드)가 등록돼 있으면 쓰고, 없으면 whisper 가 CPU 로 내려간다
int wsh_init(const char * path, int use_gpu) {
    if (g_ctx != nullptr) { whisper_free(g_ctx); g_ctx = nullptr; }
    g_gpu_name.clear();
    if (use_gpu) {
        for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
            ggml_backend_dev_t dev = ggml_backend_dev_get(i);
            const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
            if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
                g_gpu_name = ggml_backend_dev_name(dev);
                break;
            }
        }
    }
    // 기본 로더(ifstream)는 수 KB 씩 읽어 WORKERFS(FileReaderSync)에서는 호출이 십만 번을 넘는다 — 큰 버퍼로 묶어 읽는다
    FILE * file = fopen(path, "rb");
    if (file == nullptr) return -1;
    setvbuf(file, nullptr, _IOFBF, LOAD_BUFFER_BYTES);
    whisper_model_loader loader = {};
    loader.context = file;
    loader.read = [](void * ctx, void * output, size_t read_size) { return fread(output, 1, read_size, (FILE *) ctx); };
    loader.eof = [](void * ctx) { return feof((FILE *) ctx) != 0; };
    loader.close = [](void * ctx) { fclose((FILE *) ctx); };
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = !g_gpu_name.empty();
    cparams.flash_attn = false; // wasm ggml-cpu flash-attn 는 멈춘다(hang) — 끈다
    g_ctx = whisper_init_with_params(&loader, cparams);
    if (g_ctx == nullptr) g_gpu_name.clear();
    return g_ctx != nullptr ? 0 : -1;
}

const char * wsh_gpu_name() { return g_gpu_name.c_str(); }

void wsh_free() {
    if (g_ctx != nullptr) { whisper_free(g_ctx); g_ctx = nullptr; }
}

// live != 0: 실시간 창 인식 — 진행률을 찍지 않고, audio_ctx 로 인코더 길이를 창 길이에 맞춰 줄일 수 있다(0 = 30초 전체)
int wsh_transcribe(const float * pcm, int n, const char * lang, int threads, int live, int audio_ctx) {
    if (g_ctx == nullptr) return -1;
    g_segs.clear();
    g_words.clear();
    g_audio_ms = (long long) n * 1000 / WHISPER_SAMPLE_RATE;
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_realtime = false;
    params.print_progress = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.translate = false;
    params.suppress_nst = true;
    params.suppress_blank = true;
    params.token_timestamps = true;
    params.no_context = true;        // 윈도우 간 문맥 이월 차단 — 환각이 뒤로 번지는 것 방지
    params.temperature = 0.0f;       // greedy 고정
    params.temperature_inc = 0.0f;   // 온도 폴백 끔 — 폴백(고온 샘플링)이 환각의 주범이다
    params.language = lang;
    params.n_threads = std::max(1, std::min(threads, 8));
    params.audio_ctx = live ? std::max(0, audio_ctx) : 0;
    params.progress_callback = live ? nullptr : on_progress;
    params.new_segment_callback = on_segment;
    const int rc = whisper_full(g_ctx, params, pcm, n);
    // 단계별 시간(인코더·디코더)을 stderr 로 — 워커가 console.debug 로 남긴다 (성능 측정용)
    whisper_print_timings(g_ctx);
    whisper_reset_timings(g_ctx);
    return rc;
}

long long wsh_audio_ms() { return g_audio_ms; }
int wsh_n_segments() { return (int) g_segs.size(); }
long long wsh_seg_t0(int i) { return g_segs[i].t0; }
long long wsh_seg_t1(int i) { return g_segs[i].t1; }
float wsh_seg_nsp(int i) { return g_segs[i].nsp; }
float wsh_seg_logprob(int i) { return g_segs[i].avg_logprob; }
const char * wsh_seg_text(int i) { return g_segs[i].text.c_str(); }

int wsh_n_words() { return (int) g_words.size(); }
long long wsh_word_t0(int i) { return g_words[i].t0; }
long long wsh_word_t1(int i) { return g_words[i].t1; }
int wsh_word_seg(int i) { return g_words[i].seg; }
const char * wsh_word_text(int i) { return g_words[i].text.c_str(); }

}