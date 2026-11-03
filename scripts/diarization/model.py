"""말소리/겹침 분류 모델 — 입력 (B, T, 80) log-mel, 출력 (B, T, 2) 로짓 [말소리, 겹침].

주파수·시간 합성곱(±0.21초) → 팽창 시간 합성곱 5단(±0.62초 더) → 선형. 앞뒤 문맥이 약 0.83초로 고정돼,
앱이 녹음을 10초 조각에 앞뒤 1초를 붙여 나눠 돌려도 한 번에 넣은 결과와 같다. 약 19만 매개변수.
(처음 설계의 GRU 는 1초보다 먼 과거를 기억해 조각 경계에 따라 결과가 달라졌다)
"""
import torch
from torch import nn

MEL_BINS = 80
TEMPORAL_DILATIONS = (1, 2, 4, 8, 16)


def _block(cin, cout, dilation, freq_stride):
    return nn.Sequential(
        nn.Conv2d(cin, cout, kernel_size=3, stride=(1, freq_stride), padding=(dilation, 1), dilation=(dilation, 1)),
        nn.BatchNorm2d(cout),
        nn.ReLU(),
    )


class Temporal(nn.Module):
    """잔차 팽창 시간 합성곱 한 단"""

    def __init__(self, channels, dilation):
        super().__init__()
        self.conv = nn.Conv1d(channels, channels, kernel_size=3, padding=dilation, dilation=dilation)
        self.norm = nn.BatchNorm1d(channels)

    def forward(self, x):
        return x + torch.relu(self.norm(self.conv(x)))


class SpeechNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm = nn.BatchNorm1d(MEL_BINS)
        self.conv = nn.Sequential(_block(1, 24, 1, 1), _block(24, 48, 5, 2), _block(48, 48, 15, 2))
        self.project = nn.Sequential(nn.Linear(48 * (MEL_BINS // 4), 96), nn.ReLU(), nn.Linear(96, 64), nn.ReLU())
        self.temporal = nn.Sequential(*[Temporal(64, d) for d in TEMPORAL_DILATIONS])
        self.out = nn.Linear(64, 2)

    def forward(self, logmel):
        x = self.norm(logmel.transpose(1, 2)).transpose(1, 2)
        x = self.conv(x.unsqueeze(1))
        b, c, t, f = x.shape
        x = self.project(x.permute(0, 2, 1, 3).reshape(b, t, c * f))
        x = self.temporal(x.transpose(1, 2)).transpose(1, 2)
        return self.out(x)


class Exported(nn.Module):
    """ONNX 용 — 시그모이드까지 넣어 확률을 낸다"""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, logmel):
        return torch.sigmoid(self.net(logmel))


def parameter_count(net):
    return sum(p.numel() for p in net.parameters())