# SSD GC Simulator - 脚本执行模式使用说明

## 目录

1. [脚本模式概述](#1-脚本模式概述)
2. [快速上手](#2-快速上手)
3. [脚本JSON格式规范](#3-脚本json格式规范)
4. [指令类型详解](#4-指令类型详解)
5. [内置脚本模板](#5-内置脚本模板)
6. [Python脚本生成器](#6-python脚本生成器)
7. [编写策略验证脚本](#7-编写策略验证脚本)
8. [常见问题](#8-常见问题)

---

## 1. 脚本模式概述

脚本执行模式允许用户通过预定义的 JSON 脚本控制 SSD 模拟器的写入行为，支持：

- **单步执行**：每次执行一个指令，观察每一步的效果
- **多步执行**：自动连续执行指定步数
- **全速执行**：一键执行全部剩余步骤
- **自动GC**：脚本执行过程中自动处理 GC 弹窗
- **脚本导入/导出**：支持 JSON 文件导入和导出
- **内置模板**：内置 5 种常用测试脚本
- **Python 生成器**：外部工具生成大规模、特定分布的脚本

### 适用场景

| 场景 | 说明 |
|------|------|
| 写入算法验证 | 验证特定写入模式下的GC行为和Write Age分布 |
| 热点测试 | 模拟真实SSD中少量LBA被频繁写入的场景 |
| GC阈值验证 | 测试不同GC触发阈值下的回收效率 |
| 教学演示 | 精确控制每一步操作，展示SSD内部原理 |
| 对比实验 | 使用相同脚本在不同配置下运行，对比结果 |

---

## 2. 快速上手

### 2.1 使用内置模板

1. 打开 `index.html`，在左侧控制面板找到"操作控制"
2. 点击 **脚本执行** 标签切换模式
3. 点击 **📋 模板** 按钮
4. 在弹出的提示框中选择一个模板编号（1-5）
5. 模板内容会自动填入编辑器
6. 点击 **加载脚本** 按钮
7. 点击 **▶ 单步** 或 **▶▶▶ 全速** 执行

### 2.2 使用示例脚本文件

1. 在脚本模式中，点击 **📤 导入** 按钮
2. 选择 `demo/scripts/` 目录下的 `.json` 文件
3. 脚本自动加载，点击执行按钮运行

### 2.3 手动编写脚本

1. 在编辑器文本框中直接输入 JSON 脚本
2. 点击 **加载脚本**
3. 验证通过后控制面板下方会显示脚本名称和进度条
4. 使用步骤控制按钮执行

---

## 3. 脚本JSON格式规范

### 3.1 顶层结构

```json
{
    "name": "脚本名称",
    "description": "脚本描述（可选）",
    "steps": [
        // ... 步骤数组
    ]
}
```

### 3.2 步骤通用字段

每个步骤必须包含 `type` 字段，可选择包含 `desc` 字段（步骤描述，会显示在日志中）。

### 3.3 完整语法示例

```json
{
    "name": "GC触发验证",
    "description": "写入→覆写→填满，验证GC自动触发",
    "steps": [
        { "type": "sequential", "count": 144, "desc": "填满用户空间" },
        { "type": "write", "lba": 1, "desc": "写入LBA 1" },
        { "type": "batch_write", "lbas": [5, 10, 15], "desc": "批量写入" },
        { "type": "overwrite", "lba": 1, "count": 10, "desc": "覆写10次" },
        { "type": "random", "count": 20, "range": [1, 180], "desc": "随机写入20页" },
        { "type": "gc", "desc": "手动触发GC" },
        { "type": "wait", "ms": 500, "desc": "等待500ms" },
        { "type": "assert_free_pages", "op": ">=", "value": 10, "desc": "检查空闲页" },
        { "type": "loop", "count": 3, "steps": [
            { "type": "write", "lba": 1, "desc": "循环写入LBA 1" }
        ], "desc": "循环3次" }
    ]
}
```

---

## 4. 指令类型详解

### 4.1 `write` — 写入单个LBA

写入一个指定的 LBA（逻辑块地址）。

```json
{ "type": "write", "lba": 42, "desc": "写入LBA 42" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `lba` | number | 是 | LBA地址，范围 1 ~ userPages |
| `desc` | string | 否 | 步骤描述 |

**行为**：如果 LBA 已存在映射，旧页自动标记为 invalid（覆写）。

### 4.2 `batch_write` — 批量写入

一次执行多个 LBA 的写入，最后统一渲染。

```json
{ "type": "batch_write", "lbas": [1, 2, 3, 4, 5], "desc": "批量写入5页" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `lbas` | number[] | 是 | LBA地址数组 |
| `desc` | string | 否 | 步骤描述 |

### 4.3 `overwrite` — 覆写

对同一个 LBA 连续写入多次，制造大量无效页。

```json
{ "type": "overwrite", "lba": 1, "count": 20, "desc": "覆写LBA 1共20次" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `lba` | number | 是 | LBA地址 |
| `count` | number | 是 | 覆写次数 |
| `desc` | string | 否 | 步骤描述 |

### 4.4 `random` — 随机写入

在指定范围内随机生成 LBA 进行写入。

```json
{ "type": "random", "count": 100, "range": [1, 180], "desc": "随机写入100页" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `count` | number | 是 | 写入页数 |
| `range` | number[2] | 否 | LBA范围，默认 [1, userPages] |
| `desc` | string | 否 | 步骤描述 |

### 4.5 `sequential` — 顺序写入

按当前 LBA 指针顺序写入，和手动模式下的"顺序写入"行为一致。

```json
{ "type": "sequential", "count": 36, "desc": "顺序写入36页（1个SB）" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `count` | number | 是 | 写入页数 |
| `desc` | string | 否 | 步骤描述 |

### 4.6 `gc` — 触发GC

手动触发一次垃圾回收。

```json
{ "type": "gc", "desc": "手动触发GC" }
```

**注意**：当 **自动GC** 选项开启时，脚本执行过程中如果触发了 GC 弹窗，脚本引擎会自动处理（确认执行并跳过动画）。建议保持自动GC开启。

### 4.7 `wait` — 等待

暂停执行指定的毫秒数，用于控制执行节奏。

```json
{ "type": "wait", "ms": 1000, "desc": "等待1秒" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ms` | number | 是 | 等待的毫秒数 |
| `desc` | string | 否 | 步骤描述 |

### 4.8 `assert_*` — 断言

在执行过程中检查系统状态，用于自动化验证。

```json
{ "type": "assert_free_pages",    "op": ">=", "value": 10, "desc": "空闲页≥10" }
{ "type": "assert_gc_count",      "op": ">=", "value": 1,  "desc": "GC至少触发1次" }
{ "type": "assert_write_count",   "op": "==", "value": 50, "desc": "写入计数=50" }
{ "type": "assert_invalid_pages", "op": ">=", "value": 5,  "desc": "无效页≥5" }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 断言类型（见下方） |
| `op` | string | 否 | 比较运算符：`>`, `<`, `>=`, `<=`, `==`（默认 `>=`） |
| `value` | number | 是 | 预期值 |
| `desc` | string | 否 | 步骤描述 |

**断言类型对应检查项：**

| 断言类型 | 检查项 | 说明 |
|----------|--------|------|
| `assert_free_pages` | 空白页数量 | 物理盘中的空白页总数 |
| `assert_gc_count` | GC触发次数 | 累计GC触发次数 |
| `assert_write_count` | 用户写入次数 | 累计用户写入LBA次数 |
| `assert_invalid_pages` | 无效页数量 | 当前无效页总数 |

**断言失败时**：脚本会中止执行并报告失败。

### 4.9 `loop` — 循环

将一组步骤重复执行多次。在加载脚本时会被展开为扁平步骤序列。

```json
{
    "type": "loop",
    "count": 3,
    "desc": "循环3轮",
    "steps": [
        { "type": "write", "lba": 1, "desc": "写入LBA 1" },
        { "type": "write", "lba": 2, "desc": "写入LBA 2" }
    ]
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `count` | number | 是 | 循环次数 |
| `steps` | array | 是 | 子步骤数组 |
| `desc` | string | 否 | 步骤描述 |

---

## 5. 内置脚本模板

模拟器内置了5种脚本模板，点击 **📋 模板** 按钮选择：

| 编号 | 模板名称 | 用途 |
|------|----------|------|
| 1 | 热点LBA覆写测试 | 对LBA 1-5反复写入，制造大量无效页触发GC |
| 2 | GC触发验证 | 写入→覆写→填满，验证GC自动触发的条件 |
| 3 | 随机写入压力测试 | 全盘随机写入和覆写，观察Write Age分布变化 |
| 4 | 断言验证示例 | 演示断言指令的使用方式 |
| 5 | 空盘基准测试 | 按SB粒度逐步写入，观察整个过程 |

`demo/scripts/` 目录下还提供了3个预制的示例JSON文件，可以直接导入使用：

| 文件 | 内容 |
|------|------|
| `example_hotspot.json` | 热点区域覆写 + GC触发 |
| `example_gc_stress.json` | GC压力测试（含断言验证） |
| `example_zipf.json` | Zipf分布模拟热点访问 |

---

## 6. Python脚本生成器

### 6.1 概述

`demo/scripts/gen_script.py` 是一个 Python 脚本生成器，用于生成大规模、特定分布的测试脚本。它支持多种访问模式分布模型，适合用于验证写入策略算法。

### 6.2 安装要求

- Python 3.6+
- 无需额外的第三方库（仅使用标准库）

### 6.3 基本用法

```bash
# 查看帮助
python gen_script.py --help

# 生成100步均匀分布随机写入
python gen_script.py --type uniform --steps 100 -o random_100.json

# 生成500步Zipf热点写入（alpha=1.5，分布更倾斜）
python gen_script.py --type zipf --steps 500 --zipf-alpha 1.5 -o zipf.json

# 生成热点区域写入（LBA 1-20和50-70为热点，访问概率80%）
python gen_script.py --type hotspot --hotspots "1,20:50,70" --steps 200 -o hotspot.json

# 生成混合负载（70% Zipf + 30% 均匀分布）
python gen_script.py --type mixed --steps 300 --mix-ratio 0.7 -o mixed.json

# 生成GC压力测试
python gen_script.py --type gc_stress -o gc_stress.json

# 指定随机种子（可复现的结果）
python gen_script.py --type zipf --steps 100 --seed 42 -o reproducible.json
```

### 6.4 脚本类型参数

| 类型 | 生成器 | 可用参数 |
|------|--------|----------|
| `uniform` | 均匀分布 | `--steps`, `--batch`, `--min-lba`, `--max-lba` |
| `zipf` | Zipf分布 | `--steps`, `--zipf-alpha`, `--batch`, `--min-lba`, `--max-lba` |
| `hotspot` | 热点区域 | `--steps`, `--hotspots`, `--hot-prob`, `--batch` |
| `sequential` | 顺序写入 | `--steps`, `--seq-start`, `--batch` |
| `mixed` | 混合负载 | `--steps`, `--mix-ratio`, `--zipf-alpha`, `--batch` |
| `gc_stress` | GC压力测试 | `--user-pages`, `--gc-hot-writes`, `--gc-fill-pages` |

### 6.5 通用参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-o, --output` | `script_output.json` | 输出文件路径 |
| `-s, --steps` | 100 | 写入步数 |
| `-t, --type` | uniform | 脚本类型 |
| `--min-lba` | 1 | 最小LBA |
| `--max-lba` | 180 | 最大LBA |
| `--batch` | 1 | 每步写入页数 |
| `--seed` | (随机) | 随机种子 |
| `--no-pretty` | (关闭) | 压缩JSON输出 |

### 6.6 使用示例：验证不同写入策略

**场景：** 比较三种写入模式对GC效率的影响

```bash
# 1. 生成测试脚本
python gen_script.py --type zipf --steps 500 --zipf-alpha 1.5 -o test_zipf.json --seed 42
python gen_script.py --type uniform --steps 500 -o test_uniform.json --seed 42
python gen_script.py --type hotspot --hotspots "1,20:80,100" --steps 500 -o test_hotspot.json --seed 42

# 2. 分别导入模拟器执行
# 观察每个脚本执行后的 Write Age 分布和 GC 触发次数
```

**场景：** 大规模参数扫参

```python
# 可以用Python批量生成不同参数的脚本
import subprocess

for alpha in [1.0, 1.2, 1.5, 2.0]:
    subprocess.run([
        "python", "gen_script.py",
        "--type", "zipf",
        "--steps", "1000",
        f"--zipf-alpha", str(alpha),
        f"-o", f"zipf_alpha_{alpha}.json",
        "--seed", "42"
    ])
```

---

## 7. 编写策略验证脚本

### 7.1 写放大系数测试

```json
{
    "name": "写放大系数(WAF)测试",
    "description": "反复覆写少量LBA，观察GC写放大",
    "steps": [
        { "type": "sequential", "count": 180, "desc": "填满全盘" },
        { "type": "loop", "count": 5, "steps": [
            { "type": "overwrite", "lba": 1, "count": 10, "desc": "覆写LBA 1十次" },
            { "type": "overwrite", "lba": 2, "count": 10, "desc": "覆写LBA 2十次" },
            { "type": "sequential", "count": 36, "desc": "继续写入" }
        ], "desc": "5轮热点覆写" },
        { "type": "assert_gc_count", "op": ">=", "value": 1, "desc": "至少触发1次GC" }
    ]
}
```

观察指标：`用户写入LBA数目` vs `SSD实际写入LBA数目` 的比值。

### 7.2 GC阈值对比测试

1. 先在配置面板中设置 GC 阈值为 0（满时触发）
2. 执行脚本，记录 GC 触发时的状态
3. 重置 SSD，设置 GC 阈值为 18（半个SB）
4. 再次执行同样脚本，观察 GC 触发时机的差异

### 7.3 冷热数据分离验证

```json
{
    "name": "冷热数据分离测试",
    "description": "模拟冷热数据混合写入，观察Write Age分布",
    "steps": [
        { "type": "sequential", "count": 180, "desc": "初始填盘" },
        { "type": "loop", "count": 10, "steps": [
            { "type": "write", "lba": 1, "desc": "热数据 LBA 1" },
            { "type": "write", "lba": 2, "desc": "热数据 LBA 2" },
            { "type": "write", "lba": 90, "desc": "温数据 LBA 90" },
            { "type": "write", "lba": 150, "desc": "冷数据 LBA 150" }
        ], "desc": "混合写入循环" },
        { "type": "sequential", "count": 36, "desc": "触发GC" }
    ]
}
```

执行后观察 Write Age 分布图的拟合线——斜率越缓，说明冷热数据分离越好。

---

## 8. 常见问题

### Q: 脚本执行时卡住不动了？

A: 可能原因：
- GC 弹窗未自动处理：检查 **自动GC** 复选框是否开启
- 写入空间不足：脚本中的写入步骤超过了可用物理空间
- 点击 **■ 停止** 按钮中止当前执行，然后检查脚本逻辑

### Q: 如何中断正在执行的脚本？

A: 点击 **■ 停止** 按钮，当前步骤执行完成后会立即中止。

### Q: 脚本导入报错"JSON解析错误"？

A: 检查以下常见问题：
- JSON 末尾不能有逗号（如 `[1, 2, 3,]` 是非法格式）
- 字符串必须用双引号（`"key"`），不能用单引号
- 可以使用 [json.cn](https://www.json.cn) 等工具验证JSON格式

### Q: 脚本的 "总步数" 和实际执行步数不一致？

A: `loop` 指令在加载时会展开为具体的步骤，所以实际步数 = 所有子步骤之和。在脚本控制面板显示的 "N / M" 中是展开后的步数。

### Q: 如何保证测试结果可复现？

A: 使用 Python 生成器时指定 `--seed` 参数（如 `--seed 42`），每次生成的 LBA 序列完全相同。

### Q: 脚本模式和手动模式能混合使用吗？

A: 可以。切换模式不会重置 SSD 状态。可以在手动模式先做一些操作，再切换到脚本模式继续执行。反之亦然。

### Q: 速度滑块各档位对应多快的速度？

| 档位 | 名称 | 每步延迟 |
|------|------|----------|
| 0 | 极慢 | ~300ms |
| 2 | 慢 | ~100ms |
| 4 | 较慢 | ~60ms |
| 5 | **中** | **~50ms** |
| 7 | 快 | ~37ms |
| 9 | 最快 | ~30ms |
| 10 | 跳过 | 0ms（无延迟） |

---

## 9. 全盘填充脚本生成器

除了通用生成器 `gen_script.py` 外，还提供了两个专用填充脚本生成器，专门用于生成全盘物理容量的写入脚本。

### 9.1 `fill_sequential.py` — 全盘顺序填充

生成一个按 LBA 顺序写满整个物理盘（用户空间 + OP 空间）的脚本。

```
python fill_sequential.py --output seq_fill.json
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-o, --output` | `seq_fill_all.json` | 输出文件路径 |
| `--total-pages` | 216 | 物理盘总页数 (默认可配: 6SB×4Die×9Page) |
| `--divide` | 0 | 分批写入粒度，0=一次性写入，36=按SB粒度分步 |
| `--name` | (自动) | 脚本名称 |

**示例：**

```bash
# 一次性写入216页（用户空间180 + OP空间36）
python fill_sequential.py -o seq_fill.json

# 按SB粒度（36页/步）分批写入，便于逐步观察
python fill_sequential.py -o seq_fill_sb.json --divide 36

# 自定义容量：10个SB × 36页 = 360页
python fill_sequential.py -o seq_fill_360.json --total-pages 360
```

**生成脚本的行为：**
1. 使用 `sequential` 指令一次性（或分批）写入全部页
2. 模拟器自动处理 PSB 切换和 OP 空间的使用
3. 物理盘满后会触发 GC（当 GC 阈值 > 0 时）
4. 包含断言验证写入计数

### 9.2 `fill_random.py` — 全盘随机填充

生成多轮随机写入脚本，第1轮填满用户空间，后续轮次通过随机覆写制造无效页触发 GC。

```
python fill_random.py --output rand_fill.json
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-o, --output` | `rand_fill.json` | 输出文件路径 |
| `--total-pages` | 216 | 物理盘总页数 |
| `--user-space` | 180 | 用户空间页数（也是 LBA 范围上限） |
| `--rounds` | 2 | 写入轮数。第1轮填盘，后续轮覆写制造无效页 |
| `--seed` | (随机) | 随机种子，用于可复现结果 |
| `--name` | (自动) | 脚本名称 |

**示例：**

```bash
# 默认：2轮，共216页（第1轮180页填用户空间，第2轮36页覆写填OP空间）
python fill_random.py -o rand_fill.json

# 3轮写入，更容易触发GC
python fill_random.py --rounds 3 -o rand_fill_3r.json

# 指定固定种子，确保每次生成的LBA序列一致
python fill_random.py --seed 42 -o rand_fill_deterministic.json

# 自定义空间分配
python fill_random.py --user-space 144 --op-space 72 -o rand_fill_custom.json
```

**为什么多轮能确保触发GC：**

| 轮次 | 写入页数 | 说明 |
|------|----------|------|
| 第1轮 | 用户空间(180) | 填满用户空间，开始使用OP空间 |
| 第2轮 | total - user(36) | 随机覆写，制造无效页，触发GC回收 |
| 第3轮+ | 更多覆写 | 进一步增大无效页比例，强制GC |

生成脚本包含 `assert_gc_count >= 1` 断言来验证 GC 确实被触发。

### 9.3 ScriptBuilder 框架 — 用代码定义脚本

`fill_sequential.py` 和 `fill_random.py` 内部封装了统一的 `ScriptBuilder` 框架。用户只需编写 `user_operations()` 函数，在其中调用 LBA 操作接口即可生成脚本，无需关心 JSON 结构、描述生成、断言添加和文件写入等细节。

**ScriptBuilder 提供的 ctx 接口：**

| 方法 | 说明 |
|------|------|
| `ctx.write(lba, desc?)` | 写入单个 LBA |
| `ctx.sequential(count, desc?)` | 顺序写入 N 个 LBA |
| `ctx.gc(desc?)` | 触发 GC |
| `ctx.wait(ms, desc?)` | 等待指定毫秒数 |
| `ctx.assert_write_count(op, value, desc?)` | 断言写入次数 |
| `ctx.assert_gc_count(op, value, desc?)` | 断言 GC 触发次数 |
| `ctx.assert_free_pages(op, value, desc?)` | 断言空闲页数 |

**自定义脚本示例：**

```python
# custom_fill.py — 自定义写入模式
from fill_sequential import generate_script, ScriptBuilder

def my_operations(ctx, total_pages=216, divide_by=None):
    """先顺序填盘，再覆写热点，最后 GC"""
    user_pages = ctx.user_pages  # 180

    # 阶段1: 逐LBA填满用户空间
    for i in range(user_pages):
        lba = (i % user_pages) + 1
        ctx.write(lba, desc=f"填盘 LBA {lba}")

    # 阶段2: 覆写热点 LBA 1 制造无效页
    for i in range(20):
        ctx.write(1, desc=f"覆写 LBA 1 ({i+1}/20)")

    # 阶段3: 触发 GC
    ctx.gc("手动触发 GC")

    # 阶段4: 验证 GC 执行成功
    ctx.assert_gc_count(">=", 1, "验证 GC 至少触发 1 次")

# 生成脚本
script = generate_script(my_operations, total_pages=216)

# 保存到文件
import json
with open("my_custom_script.json", "w", encoding="utf-8") as f:
    json.dump(script, f, ensure_ascii=False, indent=2)
```

**内部架构：**

```
fill_sequential.py / fill_random.py
│
├── class ScriptBuilder          # 构建器，提供 write/sequential/gc/assert 等接口
│   └── ctx.build(name, desc)    # 组装完整 JSON 脚本
│
├── def user_operations(ctx, ...) # 用户操作层 —— 只需在这里调用 ctx 接口
│
├── def generate_script(fn, ...)  # 框架入口：创建 ctx → 调用 user_operations → 构建脚本
│
├── def build_xxx_script(...)     # 旧接口兼容（内部调用 generate_script）
│
└── def main()                    # CLI 接口
```

使用 `ScriptBuilder` 框架编写自定义脚本时，只需关注 `user_operations()` 函数内部的 LBA 操作逻辑，框架会自动处理：
- 步骤描述的自动生成（也可传 `desc` 参数覆盖）
- 脚本名称和描述信息的组装
- 断言参数的标准化
- 文件写入（通过 `generate_script` + 外部 `json.dump`）

---

## 10. 测试套件

模拟器附带两套测试，用于验证各模块逻辑的正确性。

### 10.1 浏览器测试套件

`demo/__tests__/test_runner.html`

直接在浏览器中运行的完整测试套件，覆盖所有核心模块：

| 模块 | 测试内容 | 用例数 |
|------|----------|--------|
| CONFIG 配置管理 | 默认值、派生值、OP范围 | 3 |
| SSD 状态管理 | 初始化、页结构、映射表、历史记录、undo | 13 |
| 写入策略 | 单页写入、PSB切换、覆写、顺序/随机、OP空间、写入失败 | 9 |
| GC策略 | victim选择、无无效页处理 | 4 |
| 脚本策略 | 校验逻辑、加载、loop展开、单步执行、重置 | 14 |
| 集成测试 | 全盘写入、invalid页、计数、GC回收、脚本执行模式 | 9 |

**使用方法：**

```bash
# 直接用浏览器打开
open demo/__tests__/test_runner.html

# 或启动HTTP服务
cd demo && python -m http.server 8080
# 访问 http://localhost:8080/__tests__/test_runner.html
```

**执行方式：**
- **运行所有测试** — 执行全部 6 个套件 ~50 个测试用例
- **仅运行断言测试(快)** — 只运行脚本策略模块的测试
- **展开/折叠全部** — 查看测试详情

### 10.2 Python CLI 测试

`demo/__tests__/test_scripts_logic.py`

在命令行中运行的测试，无需浏览器，用于验证脚本JSON生成质量和校验逻辑。

```bash
cd demo/__tests__

# 运行所有测试（详细输出）
python test_scripts_logic.py -v

# 仅验证示例JSON文件（跳过生成器）
python test_scripts_logic.py --skip-generator
```

**测试覆盖：**

| 套件 | 用例数 | 说明 |
|------|--------|------|
| 脚本生成器输出验证 | 33 | 验证 fill_sequential/fill_random/gen_script 各类型的输出 |
| 脚本JSON校验逻辑 | 15 | 在Python端复现JS的validateScript逻辑 |
| 示例JSON文件验证 | 12 | 验证 example_*.json 的格式和校验 |
| 分布质量验证 | 2 | Zipf分布的热点倾斜特性验证 |
| 填充脚本一致性验证 | 4 | 分步逻辑、容量关系 |

**测试结果示例：**
```
============================================================
结果: 67/67 通过
============================================================
```
