# AutoDL 3090 模型基础服务

已部署两个独立 Conda 环境，保留平台 Miniconda、CUDA 和驱动。`/data` 指向现有数据盘 `/root/autodl-tmp`；源码、配置、缓存、权重和日志均在 `/data/hsbc`。此目录只提供模型工具接口，业务状态与恢复由 APP 管理。

## 部署与运行

在相同 AutoDL Ubuntu 22.04 基础实例中，将本目录复制到服务器后执行 `bash install.sh`。先应用稳定仓库系统补丁，禁止 `jammy-proposed`，保留 GPU/CUDA/平台相关包，不执行 autoremove 或重启。升级证据写入 `deploy/os-upgrade-*`。现有 `/usr/sbin/policy-rc.d` 必须拒绝包安装自动重启服务。

安装脚本使用精确 Python 依赖锁、官方 Paddle cu126 包及模型哈希锁。NER 固定 Hugging Face revision，OCR 使用官方 BOS 档案并核验每个运行文件。下载代理只在下载子 shell 中启用；常驻进程清除代理并从本地模型路径离线加载。`record_versions.py` 记录实际组件、Conda 包地址和部署文件哈希。

```bash
/data/hsbc/scripts/start-gpu3090.sh
/usr/bin/supervisord ctl -s unix:///data/hsbc/run/supervisor3090.sock status
/data/hsbc/envs/ner/bin/python /data/hsbc/scripts/smoke.py
```

使用平台已有 Go Supervisor 0.6.8 的独立实例，不修改平台 Supervisor 配置。进程崩溃后自动重启；APP SSH 的受限 `hsbc-bootstrap` 命令可在实例恢复时幂等启动项目监督器，不等待模型加载。APP 专用公钥只允许两条 loopback 转发和该命令。启动脚本验证数据盘，未挂载时拒绝启动。

安装/API 依据：[PaddleOCR-VL 官方文档](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html)、[GLiNER2.5 Multi 官方模型卡](https://huggingface.co/fastino/gliner2.5-multi-v1)、[Go Supervisor 官方项目](https://github.com/ochinchina/supervisord)、[AutoDL 网络加速文档](https://www.autodl.com/docs/network_turbo/)。

## 接口约定

| 监听 | 接口 | 输入 |
|---|---|---|
| `127.0.0.1:6006` | `POST /v1/ocr` | multipart `file`，可选 `return_word_box`；PNG/JPEG，最大 10 MiB、20 百万像素 |
| `127.0.0.1:6008` | `POST /v1/entities` | JSON `text`、`labels`、可选 `word_splitter` |
| `127.0.0.1:6008` | `POST /v1/classify` | 同上，返回 `label` 分类和置信度 |
| 两个监听 | `GET /health/live`、`GET /health/ready` | 无正文 |

所有接口均需 `Authorization: Bearer <token>`。令牌分别在 `/data/hsbc/secrets/ocr.token`、`ner.token`，权限 0600；不得提交到仓库或打印到日志。端口只监听回环，经 APP SSH 隧道访问。未知路径被 Nginx 拒绝。

OCR 默认返回 `pages[].result` 和 `pages[].markdown`，PDF 应由 APP 先渲染为页面图片。词级定位的参数和附加结果见下节。NER/分类文本最大 20,000 字符；1–64 个非空标签，每标签最多 128 字符；文本加标签和保留标记的 token 预算为 3,800，超限返回 422，由调用方切分。英文默认 `word_splitter: "whitespace"`；中文需显式 `word_splitter: "char"`。合成中英文样本均已通过；业务准确率须用真实获批样本另行评估。

每个模型同时执行一个请求，忙时返回 503 与 `Retry-After: 2`。`live` 只表示 HTTP 进程存活；`ready` 必须完成模型加载和合成推理预热才返回 200，加载或失败返回 503。断线请求由 APP 持久化任务重试，SSH 重连不恢复原请求。

## 可选 NER 来源位置与隔离验收

适配器已实现 `POST /v1/entities` 的可选 JSON 布尔参数 `include_spans`。默认或 `false` 保持原调用及响应，分类接口不变。`true` 只调用锁定 GLiNER2 2.1.0 的原生 `include_spans=True`，返回：

```json
{"entities":{"person":[{"text":"Alice","confidence":0.9,"start":2,"end":7}]},"offset_unit":"unicode_code_point"}
```

`start`/`end` 是**原始请求字符串**的 Unicode code point 半开区间；不是 UTF-8 字节或 JavaScript UTF-16 偏移。保证 `text == request.text[start:end]`。上游可能对文本 `.strip()` 但不调整偏移，适配器只按该原始区间的两侧空白同步收窄；不搜索同名文字、不推测偏移、不合并重复出现，也不删除短实体。`include_spans` 仅接受真正的 JSON 布尔值。

原生接口不支持 span 返回 503 `ner_spans_unavailable`；缺失、越界、错位或不一致的 span 返回 422 `ner_span_invalid`。空实体也必须返回 `offset_unit`，调用方不得把旧服务忽略参数后的空响应当作支持。新隐私流程是否启用由 APP 单独控制；本变更不自动替换生产 NER。依据为锁定 wheel `gliner2-2.1.0-py3-none-any.whl`（SHA256 `0c242c5de53f37020df835788fc4eb820e1673b5212c202cd90e9234a7e786bc`）的 `inference/runtime.py` 与 `models/boundary/engine.py`。

隔离启动使用 [isolated_ner.py](isolated_ner.py)，复用既有 `/data/hsbc/envs/ner` 和原模型哈希锁，不安装依赖或下载模型。把脚本的 `FILES` 六个文件复制至新暂存目录，生成 `isolation-manifest.json`：`{"files":{"文件名":"SHA256", ...}}`，然后：

```bash
/data/hsbc/envs/ner/bin/python /path/to/stage/isolated_ner.py preflight \
  --stage /path/to/stage --manifest-sha256 <manifest-sha256>
# 核对预检后才运行；status/stop 使用相同参数。
/data/hsbc/envs/ner/bin/python /path/to/stage/isolated_ner.py start \
  --stage /path/to/stage --manifest-sha256 <manifest-sha256>
```

预检核对暂存哈希、全部锁定依赖、原权重逐文件哈希、8003 端口、至少 8 GiB 空余显存，以及既有 `6006`/`6008` Nginx 入口健康（对应后台 `8001`/`8002`）。新进程只监听 `127.0.0.1:8003`，运行于 `/data/hsbc/evaluations/ner-spans-<hash>`，独立 token、缓存、日志及 PID 记录。`MODEL_RUNTIME_ROOT` 只接受该 evaluations 根目录下的直接子目录且只用于 NER，默认生产路径不变。暖机期间空余显存低于 6 GiB、超时或旧服务健康变化，只停止新进程；已存在的未知隔离目录不自动重启。状态与停止命令核对 PID 启动时刻、目录和端口，防止误碰重用的 PID。

APP 如需访问，使用新建的临时受限 SSH key，仅允许转发至 `127.0.0.1:8003`，APP 侧仅绑定 Docker 私网桥的独立端口；不得扩大生产 key 权限、替换现有隧道、开放公网监听或打印 token。真实文本诊断和模型请求须另有明确范围；隔离启动只做固定合成暖机。

Nginx 关闭访问日志并仅记录 critical 错误；适配器常规错误仅记录错误类型，不记录正文、完整输入或输出。上传流式转发，避免 Nginx worker 在 `/root` 下写临时正文。Paddle 初始化和请求推理使用同一个专用线程，避免 Paddle 线程局部执行模式不一致。

## OCR 版面解析与词级定位

`POST /v1/ocr` 只接受 `multipart/form-data`。参数在表单正文中传递，URL 不接受查询参数。

| 表单字段 | 约束 | 行为 |
|---|---|---|
| `file` | 必须且只能出现一次；上传 PNG/JPEG 文件 | 最大 10 MiB、20 百万像素；不接收 PDF、URL 或服务器文件路径 |
| `return_word_box` | 可选且只能出现一次；严格使用小写字符串 `"false"` 或 `"true"` | 默认 `"false"`；`"true"` 时在 VL 版面解析之后执行 PP-OCR，追加词级结果 |

`1`、`yes`、`True`、空字符串均不是有效布尔值。任意查询参数、未知表单字段（例如 `use_word_boxes`）、重复 `file` 或重复 `return_word_box` 都返回 422，不再静默忽略。

默认请求和 `return_word_box=false` 保持原来的 `pages[].result`、`pages[].markdown`，不额外执行 PP-OCR。`return_word_box=true` 保留这些字段，并在每页追加 `pages[].word_ocr`；VL 文本和 PP-OCR 文本来自不同产线，不能用数组位置假定它们逐块对应。

词级产线固定为 `PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec`，和 VL 使用同一个 OCR Conda 环境及专用推理线程。两个产线均需完成加载与合成预热才报告就绪；单次请求先 VL、后 PP-OCR，服务并发为 1。PP-OCR 检测输入长边上限 1600，识别 batch 为 1。文档方向分类、图像矫正和文本行方向分类均禁用，APP 应提供方向正确的页面渲染图。

`word_ocr` 提供模型、图片宽高、坐标系与粒度元数据，以及以下原生结果。下标 `i` 表示识别行，`j` 表示该行中的文字单位；三个 `text_word*` 数组按相同的 `i`、`j` 对齐，保留上游的空格及标点单位。

| 字段 | 结构与含义 |
|---|---|
| `rec_texts` | `string[]`，行文本 |
| `rec_scores` | `number[]`，行级识别置信度，不是逐词置信度 |
| `rec_polys` | 每行四个 `[x, y]` 点组成的检测多边形 |
| `text_word` | `string[][]`，通常为英文单词/数字组、中文单字及符号组 |
| `text_word_region` | `[i][j]` 对应四个 `[x, y]` 点 |
| `text_word_boxes` | `[i][j]` 对应 `[x_min, y_min, x_max, y_max]` |

坐标使用上传图片的原始像素系（`original_image_pixels`），不是归一化坐标或 1600 边长的检测输入坐标。接口保留上游坐标，靠近页边的框可能超出图像边界；前端绘制时可按页面裁剪。`granularity=latin_word_cjk_character` 不表示中文语义分词；`method=ctc_alignment` 表示根据 CTC 识别位置推导文字边界，倾斜、弯曲、密集文字仍需检查定位效果。需要中文词组高亮时，由 APP 将对应字符框组合。调用方不应把行分数包装成词级分数。

请求了词框但模型不可用、推理失败或结果数组结构校验失败时，不会返回只有 VL 的成功结果。HTTP 状态如下：

| 状态 | 含义 |
|---|---|
| `200` | 请求完成；空白图片可能没有文字框，不能仅凭 200 判断识别到文字 |
| `401` | 缺少或错误的 Bearer 令牌 |
| `413` | 图片文件超过 10 MiB |
| `422` | 参数非法、重复或未知，或图片格式/像素限制不满足 |
| `503` | 模型未就绪或正在处理其他请求；忙时附带 `Retry-After: 2` |
| `500` | 推理或词级结果结构校验失败；不会静默降级 |

本机安全调用示例见 [开发连接说明](../dev/README.md#ocr-调用示例)。上游接口与坐标实现参考：[PaddleOCR 3.7.0](https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/paddleocr/_pipelines/ocr.py)、[PaddleX 3.7.2 OCR 输出](https://github.com/PaddlePaddle/PaddleX/blob/v3.7.2/paddlex/inference/pipelines/ocr/pipeline.py)、[CTC 词框计算](https://github.com/PaddlePaddle/PaddleX/blob/v3.7.2/paddlex/inference/pipelines/components/common/cal_ocr_word_box.py)。

## 已完成的验证

- 2026-10-13 已上线 PP-OCRv6 medium 词级定位：正式入口 15 项 HTTP 测试、22 项参数/结果单测及 APP Node 经隧道的 11 项 OCR/NER 回归通过。1000×700 中英合成页返回 25 个定位单元（含空白组），2000×2800 页返回 140 个；全部坐标与文字数组对应。VL＋PP-OCR＋NER 总显存实测峰值 7042 MiB、最低空闲 17083 MiB，适用于当前并发 1 和本次合成页范围。完整证据与词框叠图见 [上线验收](../evidence/ppocr-20261013/README.md)。
- 新增权重逐文件哈希见 `ppocr-model-artifacts.lock.json`。复测可在 3090 执行 `envs/ocr/bin/python app/gpu3090/ppocr_smoke.py --base-url http://127.0.0.1:6006 --output deploy/ppocr-recheck.json`（先 `cd /data/hsbc`）；生成中文测试图需要 `fonts-wqy-microhei`，当前服务器已安装。
- `gpu3090-smoke.json`：鉴权、进程与模型就绪、英文/中文实体、分类、过长输入拒绝和真实上传图片 OCR。
- `gpu3090-recovery.json`：主动终止 NER 后由 Supervisor 自动重启并恢复就绪，约 13 秒。
- `gpu3090-post-upgrade.json`：225 个系统包更新完成，两个模型保持就绪；平台 Supervisor、Miniconda Python 二进制及 NVIDIA 驱动未改变。3 个 Mesa 图形库因依赖变化保留，`libxnvctrl0` 因 GPU 平台保护显式保留。未重启平台进程，因此这不表示所有平台长驻进程已重新加载新系统库。
- APP Node 容器端到端验证见 `../app/app-gpu3090-acceptance.json`；SSH 自动重连和受限密钥测试由 APP 部署负责。
- 精确版本、模型哈希和 Conda/Python 锁文件位于本目录及服务器 `/data/hsbc/deploy`。24 小时低频连通观察尚需 APP 持续执行，不能用上述短时测试替代。
