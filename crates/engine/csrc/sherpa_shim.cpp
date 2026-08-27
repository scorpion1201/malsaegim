// 말새김 sherpa-onnx 브리지 — 온라인(스트리밍) 인식기의 C API 를 Rust 가 부르기 쉬운 함수로 감싼다.
// 설정 구조체는 여기서 만든다(예전 sherpa.worker.ts 의 recognizerConfig 와 동일: zipformer transducer, cjkchar,
// greedy, 엔드포인트 2.4/1.2/20초). 실제 인식은 sherpa-onnx(내부 C++)가 하고, Rust(malsaegim-engine-stream)가 감싼다.
#include "sherpa-onnx/c-api/c-api.h"

#include <cstring>
#include <string>

static const SherpaOnnxOnlineRecognizer *g_rec = nullptr;
static const SherpaOnnxOnlineStream *g_stream = nullptr;
static std::string g_result;

extern "C" {

int ssh_create(const char *enc, const char *dec, const char *joiner, const char *tokens) {
    if (g_stream) { SherpaOnnxDestroyOnlineStream(g_stream); g_stream = nullptr; }
    if (g_rec) { SherpaOnnxDestroyOnlineRecognizer(g_rec); g_rec = nullptr; }

    SherpaOnnxOnlineRecognizerConfig config;
    memset(&config, 0, sizeof(config));
    config.feat_config.sample_rate = 16000;
    config.feat_config.feature_dim = 80;
    config.model_config.transducer.encoder = enc;
    config.model_config.transducer.decoder = dec;
    config.model_config.transducer.joiner = joiner;
    config.model_config.tokens = tokens;
    config.model_config.num_threads = 1;
    config.model_config.provider = "cpu";
    config.model_config.debug = 0;
    config.model_config.modeling_unit = "cjkchar";
    config.decoding_method = "greedy_search";
    config.max_active_paths = 4;
    config.enable_endpoint = 1;
    config.rule1_min_trailing_silence = 2.4f;
    config.rule2_min_trailing_silence = 1.2f;
    config.rule3_min_utterance_length = 20.0f;
    config.hotwords_score = 1.5f;

    g_rec = SherpaOnnxCreateOnlineRecognizer(&config);
    if (!g_rec) return -1;
    g_stream = SherpaOnnxCreateOnlineStream(g_rec);
    return g_stream ? 0 : -1;
}

void ssh_accept(int sample_rate, const float *samples, int n) {
    if (!g_rec || !g_stream) return;
    SherpaOnnxOnlineStreamAcceptWaveform(g_stream, sample_rate, samples, n);
    while (SherpaOnnxIsOnlineStreamReady(g_rec, g_stream)) {
        SherpaOnnxDecodeOnlineStream(g_rec, g_stream);
    }
}

int ssh_is_endpoint() {
    return (g_rec && g_stream) ? SherpaOnnxOnlineStreamIsEndpoint(g_rec, g_stream) : 0;
}

void ssh_reset() {
    if (g_rec && g_stream) SherpaOnnxOnlineStreamReset(g_rec, g_stream);
}

void ssh_input_finished() {
    if (g_stream) SherpaOnnxOnlineStreamInputFinished(g_stream);
}

// 토큰을 그대로 이어 붙인 문자열 (BPE ▁ 는 Rust 가 공백으로 바꾼다)
const char *ssh_result() {
    g_result.clear();
    if (!g_rec || !g_stream) return g_result.c_str();
    const SherpaOnnxOnlineRecognizerResult *r = SherpaOnnxGetOnlineStreamResult(g_rec, g_stream);
    if (r) {
        if (r->tokens_arr && r->count > 0) {
            for (int i = 0; i < r->count; ++i) g_result += r->tokens_arr[i];
        } else if (r->text) {
            g_result = r->text;
        }
        SherpaOnnxDestroyOnlineRecognizerResult(r);
    }
    return g_result.c_str();
}

// 세그먼트 첫 토큰의 타임스탬프(초) — 확정 세그먼트 시작 시각 계산용
float ssh_first_ts() {
    if (!g_rec || !g_stream) return 0.0f;
    const SherpaOnnxOnlineRecognizerResult *r = SherpaOnnxGetOnlineStreamResult(g_rec, g_stream);
    float ts = 0.0f;
    if (r) {
        if (r->timestamps && r->count > 0) ts = r->timestamps[0];
        SherpaOnnxDestroyOnlineRecognizerResult(r);
    }
    return ts;
}

void ssh_destroy() {
    if (g_stream) { SherpaOnnxDestroyOnlineStream(g_stream); g_stream = nullptr; }
    if (g_rec) { SherpaOnnxDestroyOnlineRecognizer(g_rec); g_rec = nullptr; }
}

}