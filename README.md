# SSD GC Simulator (SPRandom)

交互式 SSD 垃圾回收（Garbage Collection）可视化模拟器。纯前端单页应用，无需服务器即可运行。

## 快速开始

直接用浏览器打开 `demo/index.html` 即可：

```
demo/index.html
```

无需安装任何依赖。支持 Chrome / Firefox / Edge 等现代浏览器。

## 目录结构

```
SPRandom/
│
├── demo/                               # 主应用目录
│   ├── index.html                      # 单页应用入口（UI）
│   ├── styles.css                      # 全部样式（暗色主题）
│   │
│   ├── js/                             # JavaScript 模块
│   │   ├── config.js                   # 配置管理（PSB数量、OP空间、显示布局）
│   │   ├── state.js                    # SSD 状态管理（页结构、映射表、历史记录）
│   │   ├── utils.js                    # 工具函数（日志、状态更新、高亮）
│   │   ├── writeStrategy.js            # 写入策略（顺序写入、随机写入）
│   │   ├── gcStrategy.js               # GC 策略（victim选择、分步GC动画）
│   │   ├── renderer.js                 # 渲染引擎（SSD可视化、统计图表、映射表）
│   │   ├── app.js                      # 前端交互（浮动面板、按钮绑定）
│   │   ├── scriptStrategy.js           # 脚本执行引擎（JSON脚本解释器）
│   │   └── main.js                     # 模块装配/启动入口
│   │
│   ├── scripts/                        # JSON脚本 & Python生成器
│   │   ├── README.md                   # 脚本执行模式完整文档
│   │   ├── gen_script.py               # Python脚本生成器（uniform/zipf/hotspot等）
│   │   ├── fill_sequential.py          # 全盘顺序填充脚本生成器
│   │   ├── fill_random.py              # 全盘随机填充脚本生成器
│   │   ├── example_hotspot.json        # 示例：热点覆写测试
│   │   ├── example_gc_stress.json      # 示例：GC压力测试
│   │   ├── example_zipf.json           # 示例：Zipf分布写入
│   │   └── seq_fill_all.json           # 预生成顺序填充脚本（216页）
│   │
│   └── __tests__/                      # 测试套件
│       ├── test_runner.html            # 浏览器测试运行器（6套件 ~52 测试用例）
│       └── test_scripts_logic.py       # Python CLI 脚本验证测试（67 测试用例）
│
├── SPEC.md                             # 正式规格说明书
├── README.txt                          # 简单使用说明
├── structure.txt                       # 架构概览/模块依赖树
├── TODO.txt                            # 开发需求/功能清单
├── test list.txt                       # 手动测试检查清单
├── prompt.txt                          # AI Prompt历史记录
├── LongsysLogo.jpg                     # Logo图片
└── SNDK-Sprandom.pdf                   # 参考文档
```

## SSD 物理结构

| 参数 | 默认值 | 说明 |
|------|--------|------|
| Die 通道数 | 4 | 每个 Super Block 包含 4 个 Die（物理 block） |
| 每 Block 页数 | 9 | 每个物理 block 包含 9 个 page |
| Super Block 总数 | 6 | SB0 ~ SB5 |
| OP Super Block 数 | 1 | SB5（Over-Provisioning 空间） |
| 每 Super Block 页数 | 36 | = 4 Die × 9 Page |
| 用户空间 | 180 页 | SB0 ~ SB4 |
| OP 空间 | 36 页 | SB5 |
| 总物理容量 | 216 页 | 6 SB × 36 页 |
| LBA 范围 | 1 ~ 180 | 用户可见的逻辑地址 |

## 两种操作模式

### 1. 手动模式（Manual Operation）

左侧控制面板的按钮操作：

- **顺序写入**：1页 / 1Block(9页) / 1SB(36页)
- **随机写入**：1页 / 1Block(9页) / 1SB(36页)
- **触发 GC**：手动触发垃圾回收
- **撤销/重做**：支持 100 步历史记录

### 2. 脚本模式（Script Execution）

通过 JSON 脚本自动化操作。支持 4 种执行速度：

| 速度档位 | 说明 |
|----------|------|
| 0（最慢） | 每步间隔 2000ms |
| 3（慢速） | 每步间隔 1000ms |
| 6（中速） | 每步间隔 400ms |
| 9（快速） | 每步间隔 100ms |
| 10（跳过） | 无延迟，立即执行 |

三种执行方式：

- **单步执行**：每次执行一个步骤
- **N 步执行**：一次执行指定数量的步骤
- **全速执行**：一次性执行所有剩余步骤

自动 GC 开关：开启后，脚本执行过程中自动处理 GC 弹窗（跳过动画）。

## 脚本格式

支持 12 种指令类型：

| 指令 | 参数 | 说明 |
|------|------|------|
| `write` | `lba` | 写入单个 LBA |
| `batch_write` | `lbas[]` | 批量写入多个 LBA |
| `overwrite` | `lba, count` | 重复覆写同一 LBA |
| `random` | `count, range` | 随机写入指定数量 LBA |
| `sequential` | `count` | 顺序写入指定数量 LBA |
| `gc` | - | 触发垃圾回收 |
| `wait` | `ms` | 等待指定毫秒数 |
| `loop` | `count, steps[]` | 循环执行子步骤 |
| `assert_free_pages` | `op, value` | 断言空闲页数 |
| `assert_gc_count` | `op, value` | 断言 GC 触发次数 |
| `assert_write_count` | `op, value` | 断言写入次数 |
| `assert_invalid_pages` | `op, value` | 断言无效页数 |

示例脚本（热点覆写测试）：

```json
{
  "name": "Hotspot Overwrite Test",
  "description": "填盘后反复覆写热点区域，制造无效页",
  "steps": [
    {"type": "sequential", "count": 180, "desc": "填满用户空间"},
    {"type": "loop", "count": 5, "steps": [
      {"type": "overwrite", "lba": 1, "count": 20, "desc": "覆写LBA1 × 20次"},
      {"type": "overwrite", "lba": 2, "count": 20, "desc": "覆写LBA2 × 20次"}
    ]},
    {"type": "gc", "desc": "执行垃圾回收"},
    {"type": "assert_gc_count", "op": ">=", "value": 1}
  ]
}
```

详见 [demo/scripts/README.md](demo/scripts/README.md)。

## Python 脚本生成器

### gen_script.py — 通用脚本生成器

```bash
cd demo/scripts

# uniform随机写入 100 步
python gen_script.py --output test.json

# Zipf分布写入（热点倾斜）
python gen_script.py --type zipf --steps 200 --seed 42 -o zipf.json

# 混合写入（Zipf + Uniform）
python gen_script.py --type mixed --steps 300 -o mixed.json

# GC压力测试
python gen_script.py --type gc_stress -o gc_stress.json
```

生成器类型：`uniform` | `zipf` | `hotspot` | `sequential` | `mixed` | `gc_stress`

### fill_sequential.py — 全盘顺序填充

```bash
python fill_sequential.py -o seq_fill.json               # 216条write指令（逐LBA）
python fill_sequential.py --divide 36 -o seq_sb.json     # 按SB粒度分批（36页/步）
python fill_sequential.py --total-pages 360 -o big.json  # 自定义容量
```

### fill_random.py — 全盘随机填充

```bash
python fill_random.py -o rand_fill.json             # 默认2轮：填盘+覆写
python fill_random.py --rounds 3 -o 3r.json         # 3轮随机写入
python fill_random.py --seed 42 -o deterministic.json  # 固定种子（可复现）
python fill_random.py --user-space 144 --op-space 72 -o custom.json  # 自定义分区
```

### ScriptBuilder 框架 — 用代码定义脚本

`fill_sequential.py` 和 `fill_random.py` 内部封装了 `ScriptBuilder` 框架。用户只需编写 `user_operations()` 函数，调用 LBA 操作接口即可生成脚本，无需关心 JSON 结构、描述生成、断言添加等细节。

可用接口：`ctx.write()`、`ctx.sequential()`、`ctx.gc()`、`ctx.wait()`、`ctx.assert_write_count()`、`ctx.assert_gc_count()` 等。

```python
from fill_sequential import generate_script

def my_ops(ctx, total_pages=216, divide_by=None):
    for i in range(ctx.user_pages):
        ctx.write((i % ctx.user_pages) + 1, desc=f"填盘 LBA ...")
    ctx.gc("手动触发GC")
    ctx.assert_gc_count(">=", 1, "验证GC至少触发1次")

script = generate_script(my_ops, total_pages=216)
# → script['steps'] 包含所有生成的步骤
```

详见 [demo/scripts/README.md](demo/scripts/README.md) 第 9.3 节。

## GC 工作原理

1. **触发条件**：空闲页数低于阈值（可在配置面板调整）
2. **Victim 选择**：无效页最多的 Super Block
3. **GC 过程**（4 步动画）：
   - Step 1：确认 victim PSB
   - Step 2：将有效页读取到 RAM（逐页动画，Die交错顺序）
   - Step 3：擦除 victim PSB
   - Step 4：将有效页写回（遵循写入策略）
4. **动画速度**：0（逐页动画，250ms/页）~ 10（跳过动画）

## 统计信息

### Block Write Age 面板

- 每个物理 block (SB+Die) 的 stacked bar chart
- 灰色 = 有效页、红色 = 无效页、白色 = 空闲页
- 按 write age 从大到小排序（从左到右：旧 → 新）
- 支持线性回归拟合线和目标参考线
- 悬停显示详细统计（有效/无效/空闲数、百分比、write age）

### 实时状态显示

- 已用页数、空闲页数、无效页数
- 空闲比例（阈值线预警）
- GC 触发次数、用户写入次数、GC 写入次数

## 测试

### 浏览器测试

打开 `demo/__tests__/test_runner.html`：

- 6 个测试套件，约 52 个测试用例
- 覆盖：配置管理、状态管理、写入策略、GC策略、脚本策略、集成测试
- "Run All Tests" 或 "Run Assertion Tests Only (Fast)"

### Python CLI 测试

```bash
cd demo/__tests__
python test_scripts_logic.py -v                 # 全部67个测试
python test_scripts_logic.py -v --skip-generator  # 跳过生成器测试
```

测试范围：
- 脚本生成器输出验证（33 个）
- 脚本 JSON 校验逻辑（15 个）
- 示例 JSON 文件验证（12 个）
- 分布质量验证（2 个）
- 填充脚本一致性（4 个）
- wait-time 计算验证（1 个）

## 配置

通过 UI 面板可调整的参数：

| 参数 | 范围 | 说明 |
|------|------|------|
| Super Block 数量 | 2 ~ 8 | 物理盘大小 |
| OP Super Block 数 | 0 ~ SB-1 | Over-Provisioning 空间 |
| GC 触发阈值 | 0 ~ 50% | 空闲页比例低于此值触发 GC |
| 显示列数 | 1 / 2 | PSB 排列方式 |

修改配置后点击"应用配置"会重置 SSD。
