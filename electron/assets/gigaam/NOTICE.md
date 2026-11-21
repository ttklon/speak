# Сторонние компоненты: русская модель GigaAM v3

## Что лежит в этой папке

`v3-preprocessor.onnx` (44 430 байт) — граф, который превращает звук 16 кГц в
признаки для модели. Взят из пакета `onnx-asr` 0.12.0, файл
`onnx_asr/preprocessors/data/gigaam_v3.onnx`, SHA-256
`919c3bc8a434b6e733e5fe5dcd247974d0a7b1f2bc5b6995b6ad55f7225e014d`.
Граф крошечный (9 узлов, 44 КБ), поэтому он поставляется вместе с приложением:
считать мел-фильтры вручную в JavaScript — верный способ разойтись с эталоном
на единицы в третьем знаке и получить «почти правильный» текст.

Автор `onnx-asr` — Илья Ступаков, лицензия MIT:
https://github.com/istupakov/onnx-asr

## Что скачивается при первом включении

Веса модели в приложение не входят (226 МБ). Они скачиваются с Hugging Face из
репозитория `istupakov/gigaam-v3-onnx`, закреплённого на коммите
`322c3b29492673eb7d0b434bfa9dfb8653e34d02`, и проверяются по размеру и SHA-256:

| Файл | Размер, байт | SHA-256 |
|---|---|---|
| `v3_e2e_rnnt_encoder.int8.onnx` | 224 570 477 | `4e0e076a6076cd110277e529b8ac8f32cd5297f7fbebad5341ae8ddb7d00817b` |
| `v3_e2e_rnnt_decoder.int8.onnx` | 1 159 170 | `89014e134865615b91e037157e46e389b1271e6072460efc010ea08e61e23146` |
| `v3_e2e_rnnt_joint.int8.onnx` | 687 791 | `ade116563dbf66e503b0994efab6b5861412743e52bf31c39fc3fffa3783d5d1` |
| `v3_e2e_rnnt_vocab.txt` | 13 354 | `39abae20e692998290c574e606f11a9edef2902a1995463fcff63d1490cf22b7` |

Размеры и хеши — это идентификаторы объектов LFS из
`https://huggingface.co/api/models/istupakov/gigaam-v3-onnx/tree/322c3b29492673eb7d0b434bfa9dfb8653e34d02`;
словарь в LFS не лежит, его хеш посчитан с загрузки того же коммита.

## Чья модель

GigaAM v3 — Сбер (GigaChat Team), лицензия MIT:
https://github.com/salute-developers/GigaAM

Экспорт в ONNX (`int8`) — Ilya Stupakov, лицензия MIT:
https://huggingface.co/istupakov/gigaam-v3-onnx

## Рантайм

ONNX Runtime (`onnxruntime-node`, Microsoft, MIT) — считает графы на процессоре.
Файлы весов не изменяются, модель используется как есть.

## Как проверялась реализация

Порядок шагов и формулы сверены с тремя независимыми реализациями:
`onnx-asr` (Python, эталон экспорта), `TypeWhisper.Plugin.GigaAm` (C#, отчёт о
совпадении с `onnx-asr` на 300 русских записях) и `giga-pisar-cli` (Python).
Наши собственные проверки — в `scripts/smoke-main.mjs`: разбор словаря, нарезка
длинных записей, жадное декодирование на подставных сетях, скачивание с
проверкой хеша.
