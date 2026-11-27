#!/usr/bin/env python3
"""
Собирает ggml-модель Silero VAD из официального пакета `silero-vad` (PyPI).

Зачем: приложение качает готовый `ggml-silero-v6.2.0.bin` с HuggingFace, но
HuggingFace в сборке бывает недоступен. Тогда VAD-модель можно собрать локально
из тех же весов — формат тот же, что читает whisper.cpp
(`whisper_vad_init_with_params`).

Запуск:
    pip install silero-vad numpy
    python scripts/make-vad-model.py --out models/ggml-silero-v6.2.0.bin

Формат файла (little-endian):
    int32  magic 0x67676d6c
    int32  длина строки + строка типа модели ("silero-16k")
    int32  major, minor, patch (версия Silero)
    int32  window_size (512), context_size (64), n_encoder_layers (4)
    4 x (int32 in_channels, int32 out_channels, int32 kernel)
    int32  lstm_input_size, lstm_hidden_size, final_conv_in, final_conv_out
    далее тензоры: int32 n_dims, int32 len(name), int32 dtype (0=f32, 1=f16),
                   int32 dims[n_dims] (ne0 самый быстрый), name, данные
"""

import argparse
import json
import struct
import sys
import zipfile
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover - подсказка человеку, а не стектрейс
    sys.exit('нужен numpy: pip install numpy silero-vad')

MAGIC = 0x67676D6C

# Имена тензоров — ровно те, что ищет whisper.cpp (VAD_TENSOR_NAMES),
# и размерности в порядке ggml (ne0 — самый быстрый).
PLAN = [
    ('_model.stft.forward_basis_buffer', 'stft_conv.weight', (256, 1, 258), True),
    ('_model.encoder.0.reparam_conv.weight', 'conv1.weight', (3, 129, 128), True),
    ('_model.encoder.0.reparam_conv.bias', 'conv1.bias', (128,), False),
    ('_model.encoder.1.reparam_conv.weight', 'conv2.weight', (3, 128, 64), True),
    ('_model.encoder.1.reparam_conv.bias', 'conv2.bias', (64,), False),
    ('_model.encoder.2.reparam_conv.weight', 'conv3.weight', (3, 64, 64), True),
    ('_model.encoder.2.reparam_conv.bias', 'conv3.bias', (64,), False),
    ('_model.encoder.3.reparam_conv.weight', 'conv4.weight', (3, 64, 128), True),
    ('_model.encoder.3.reparam_conv.bias', 'conv4.bias', (128,), False),
    ('_model.decoder.rnn.weight_ih', 'lstm_cell.weight_ih', (128, 512), False),
    ('_model.decoder.rnn.weight_hh', 'lstm_cell.weight_hh', (128, 512), False),
    ('_model.decoder.rnn.bias_ih', 'lstm_cell.bias_ih', (512,), False),
    ('_model.decoder.rnn.bias_hh', 'lstm_cell.bias_hh', (512,), False),
    ('_model.decoder.decoder.2.weight', 'final_conv.weight', (128, 1), True),
    ('_model.decoder.decoder.2.bias', 'final_conv.bias', (1,), False),
]


def find_safetensors() -> Path:
    """Находит silero_vad_16k.safetensors в установленном пакете silero-vad.

    Пакет импортировать нельзя: он тянет torch, а для конвертации нужны только
    веса. Поэтому ищем файл по метаданным установленного дистрибутива.
    """
    try:
        from importlib.metadata import distribution
        dist = distribution('silero-vad')
    except Exception:
        sys.exit('нет пакета silero-vad: pip install --no-deps silero-vad')
    files = dist.files or []
    for item in files:
        name = str(item)
        if name.endswith('.safetensors') and '16k' in name:
            return Path(dist.locate_file(item))
    sys.exit('в пакете silero-vad не нашлась модель 16 кГц')


def read_safetensors(path: Path):
    with open(path, 'rb') as f:
        header_len = struct.unpack('<Q', f.read(8))[0]
        header = json.loads(f.read(header_len))
        raw = f.read()
    meta = header.pop('__metadata__', None) or {}
    tensors = {}
    for name, info in header.items():
        start, end = info['data_offsets']
        dtype = {'F32': np.float32, 'F16': np.float16}[info['dtype']]
        tensors[name] = np.frombuffer(raw[start:end], dtype=dtype)
    version = str(meta.get('version', '') or '')
    return tensors, version


def main() -> None:
    ap = argparse.ArgumentParser(description='Собрать ggml-модель Silero VAD')
    ap.add_argument('--out', required=True, help='куда положить .bin')
    ap.add_argument('--version', default='', help='версия Silero (X.Y.Z)')
    args = ap.parse_args()

    src = find_safetensors()
    tensors, version = read_safetensors(src)
    version = args.version or version or '6.2.0'
    major, minor, patch = (int(x) for x in version.split('.')[:3])

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'wb') as fo:
        fo.write(struct.pack('<i', MAGIC))
        model_type = b'silero-16k'
        fo.write(struct.pack('<i', len(model_type)))
        fo.write(model_type)
        for v in (major, minor, patch):
            fo.write(struct.pack('<i', v))
        for v in (512, 64, 4):  # window, context, n_layers
            fo.write(struct.pack('<i', v))
        for in_ch, out_ch in [(129, 128), (128, 64), (64, 64), (64, 128)]:
            for v in (in_ch, out_ch, 3):
                fo.write(struct.pack('<i', v))
        for v in (128, 128, 128, 1):  # lstm_input, lstm_hidden, final_in, final_out
            fo.write(struct.pack('<i', v))

        for ggml_name, st_name, dims, half in PLAN:
            if st_name not in tensors:
                # Веса LSTM в некоторых сборках называются lstm.* — ищем по хвосту.
                alt = [k for k in tensors if k.endswith(st_name.split('.')[-1]) and 'lstm' in k]
                if not alt:
                    sys.exit(f'в safetensors нет тензора {st_name}')
                st_name = alt[0]
            data = tensors[st_name].reshape(-1)
            need = int(np.prod(dims))
            if data.size != need:
                sys.exit(f'{st_name}: {data.size} значений, ожидалось {need} ({dims})')
            if half:
                data = data.astype(np.float16)
                ftype = 1
            else:
                data = data.astype(np.float32)
                ftype = 0
            name = ggml_name.encode()
            fo.write(struct.pack('<i', len(dims)))
            fo.write(struct.pack('<i', len(name)))
            fo.write(struct.pack('<i', ftype))
            for d in dims:
                fo.write(struct.pack('<i', int(d)))
            fo.write(name)
            fo.write(data.tobytes())

    size_mb = out.stat().st_size / 1e6
    print(f'готово: {out} — {size_mb:.2f} МБ, версия Silero {version}')


if __name__ == '__main__':
    main()
