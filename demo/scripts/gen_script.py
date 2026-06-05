#!/usr/bin/env python3
"""
SSD GC Simulator - 外部脚本生成器

生成JSON格式的脚本文件，用于SSD GC模拟器的脚本执行模式。
支持多种写入分布模型，可用于验证不同的写入策略算法。

用法:
    python gen_script.py --help                     # 查看帮助
    python gen_script.py --output test.json          # 使用默认配置生成
    python gen_script.py --type zipf --steps 500     # 生成Zipf分布脚本
    python gen_script.py --type hotspot --hotspots "1,10:50,60:100,110"  # 热点区域
    python gen_script.py --type gc_stress --gc-fill  # GC压力测试脚本
"""

import json
import random
import math
import argparse
import os
from typing import List, Tuple, Optional


# ======================== 工具函数 ========================

def clamp(value, lo, hi):
    """将值限制在[lo, hi]范围内"""
    return max(lo, min(hi, value))


def progress_bar(current, total, width=40):
    """生成进度条字符串"""
    filled = int(width * current / total)
    return f"[{'#' * filled}{'.' * (width - filled)}] {current}/{total}"


# ======================== LBA生成器 ========================

def uniform_lba_generator(count: int, lba_range: Tuple[int, int], seed: Optional[int] = None):
    """均匀分布LBA生成器"""
    if seed is not None:
        random.seed(seed)
    for _ in range(count):
        yield random.randint(lba_range[0], lba_range[1])


def zipf_lba_generator(count: int, lba_range: Tuple[int, int], alpha: float = 1.2,
                       seed: Optional[int] = None):
    """
    Zipf分布LBA生成器
    符合存储系统中的"热点"访问模式，少量LBA被频繁访问

    Args:
        count: 生成的LBA数量
        lba_range: (min, max) LBA范围
        alpha: Zipf参数，越大分布越倾斜（1.0~2.0常用）
        seed: 随机种子
    """
    if seed is not None:
        random.seed(seed)

    n = lba_range[1] - lba_range[0] + 1
    min_lba = lba_range[0]

    # 计算Zipf权重
    weights = [1.0 / (i ** alpha) for i in range(1, n + 1)]
    total = sum(weights)
    probs = [w / total for w in weights]

    for _ in range(count):
        r = random.random()
        cumsum = 0.0
        for i, p in enumerate(probs):
            cumsum += p
            if r <= cumsum:
                yield min_lba + i
                break


def hotspot_lba_generator(count: int, lba_range: Tuple[int, int],
                          hotspots: List[Tuple[int, int]],
                          hot_prob: float = 0.8,
                          seed: Optional[int] = None):
    """
    热点区域LBA生成器
    指定若干LBA区间为"热点区域"，这些区域被访问的概率更高

    Args:
        count: 生成的LBA数量
        lba_range: (min, max) LBA范围
        hotspots: 热点区间列表，如 [(1,10), (50,60)]
        hot_prob: 访问热点区域的概率（0~1）
        seed: 随机种子
    """
    if seed is not None:
        random.seed(seed)

    min_lba, max_lba = lba_range
    hot_ranges = [(clamp(lo, min_lba, max_lba), clamp(hi, min_lba, max_lba))
                  for lo, hi in hotspots]

    # 计算热点区域大小
    hot_size = sum(hi - lo + 1 for lo, hi in hot_ranges)
    cold_size = (max_lba - min_lba + 1) - hot_size

    for _ in range(count):
        if hot_size > 0 and random.random() < hot_prob:
            # 从热点区域中选择
            idx = random.randint(0, hot_size - 1)
            for lo, hi in hot_ranges:
                span = hi - lo + 1
                if idx < span:
                    yield lo + idx
                idx -= span
        else:
            # 从冷区域中选择
            if cold_size <= 0:
                yield random.randint(min_lba, max_lba)
                continue

            idx = random.randint(0, cold_size - 1)
            for lo, hi in hot_ranges:
                if idx >= lo - min_lba:
                    idx += (hi - lo + 1)
            yield min_lba + idx


def sequential_lba_generator(count: int, lba_range: Tuple[int, int],
                             start: Optional[int] = None):
    """
    顺序LBA生成器
    LBA从起始值开始递增，超过范围后回绕

    Args:
        count: 生成的LBA数量
        lba_range: (min, max) LBA范围
        start: 起始LBA，默认从min开始
    """
    min_lba, max_lba = lba_range
    current = start if start is not None else min_lba

    for _ in range(count):
        yield current
        current += 1
        if current > max_lba:
            current = min_lba


def mixed_workload_generator(count: int, lba_range: Tuple[int, int],
                              write_ratio: float = 0.7,
                              zipf_alpha: float = 1.2,
                              seed: Optional[int] = None):
    """
    混合负载LBA生成器
    70%的写入使用Zipf分布（热点），30%使用均匀分布（冷数据）

    Args:
        count: 生成的LBA数量
        lba_range: (min, max) LBA范围
        write_ratio: Zipf分布写入占比
        zipf_alpha: Zipf参数
        seed: 随机种子
    """
    if seed is not None:
        random.seed(seed)

    zipf_gen = zipf_lba_generator(count, lba_range, alpha=zipf_alpha)
    uniform_count = int(count * (1 - write_ratio))
    uniform_gen = uniform_lba_generator(uniform_count, lba_range)

    # 按比例混合：从Zipf和均匀分布中交替取
    uniform_values = list(uniform_gen)
    uniform_idx = 0

    for i in range(count):
        if random.random() < write_ratio:
            yield next(zipf_gen)
        else:
            if uniform_idx < len(uniform_values):
                yield uniform_values[uniform_idx]
                uniform_idx += 1
            else:
                yield next(zipf_gen)


# ======================== 脚本构建器 ========================

def build_write_steps(lbas: List[int], batch_size: int = 1, desc_prefix: str = "写入"):
    """
    从LBA列表构建写入steps

    Args:
        lbas: LBA列表
        batch_size: 每步写入的LBA数量（1=单步单页，>1=批量）
        desc_prefix: 步骤描述前缀

    Returns:
        steps列表
    """
    steps = []
    if batch_size == 1:
        for lba in lbas:
            steps.append({
                "type": "write",
                "lba": lba,
                "desc": f"{desc_prefix} LBA {lba}"
            })
    else:
        for i in range(0, len(lbas), batch_size):
            batch = lbas[i:i + batch_size]
            if len(batch) == 1:
                steps.append({
                    "type": "write",
                    "lba": batch[0],
                    "desc": f"{desc_prefix} LBA {batch[0]}"
                })
            else:
                steps.append({
                    "type": "batch_write",
                    "lbas": batch,
                    "desc": f"{desc_prefix} 批量 {batch[0]}~{batch[-1]} ({len(batch)}页)"
                })
    return steps


def build_script(name: str, description: str, steps: list,
                 lba_range: Tuple[int, int] = (1, 180)):
    """构建完整的脚本对象"""
    return {
        "name": name,
        "description": description + f"\nLBA范围: {lba_range[0]}-{lba_range[1]}",
        "steps": steps
    }


# ======================== 脚本模板 ========================

def gen_uniform_random_script(args):
    """生成均匀分布随机写入脚本"""
    lba_range = (args.min_lba, args.max_lba)
    lbas = list(uniform_lba_generator(args.steps, lba_range, seed=args.seed))
    steps = build_write_steps(lbas, batch_size=args.batch, desc_prefix="随机")
    return build_script(
        "均匀分布随机写入",
        f"使用均匀分布生成{args.steps}次随机LBA写入，批次大小={args.batch}",
        steps, lba_range
    )


def gen_zipf_script(args):
    """生成Zipf分布热点写入脚本"""
    lba_range = (args.min_lba, args.max_lba)
    lbas = list(zipf_lba_generator(args.steps, lba_range, alpha=args.zipf_alpha, seed=args.seed))
    steps = build_write_steps(lbas, batch_size=args.batch, desc_prefix="Zipf")
    return build_script(
        f"Zipf分布热点写入(alpha={args.zipf_alpha})",
        f"Zipf分布模拟热点访问，alpha={args.zipf_alpha}，共{args.steps}次写入，批次大小={args.batch}",
        steps, lba_range
    )


def gen_hotspot_script(args):
    """生成热点区域写入脚本"""
    lba_range = (args.min_lba, args.max_lba)
    # 解析热点区间：格式 "1,10:50,60:100,110"
    hotspots = []
    for part in args.hotspots.split(':'):
        lo, hi = part.split(',')
        hotspots.append((int(lo), int(hi)))

    lbas = list(hotspot_lba_generator(
        args.steps, lba_range, hotspots,
        hot_prob=args.hot_prob, seed=args.seed
    ))
    steps = build_write_steps(lbas, batch_size=args.batch, desc_prefix="热点")
    hot_desc = "; ".join([f"[{lo}-{hi}]" for lo, hi in hotspots])
    return build_script(
        f"热点区域写入(p={args.hot_prob})",
        f"热点区域: {hot_desc}，热点概率={args.hot_prob}，共{args.steps}次写入，批次大小={args.batch}",
        steps, lba_range
    )


def gen_sequential_script(args):
    """生成顺序写入脚本"""
    lba_range = (args.min_lba, args.max_lba)
    lbas = list(sequential_lba_generator(args.steps, lba_range, start=args.seq_start))
    steps = build_write_steps(lbas, batch_size=args.batch, desc_prefix="顺序")
    return build_script(
        "顺序写入测试",
        f"从LBA {args.seq_start}开始顺序写入{args.steps}次，批次大小={args.batch}",
        steps, lba_range
    )


def gen_mixed_script(args):
    """生成混合负载脚本"""
    lba_range = (args.min_lba, args.max_lba)
    lbas = list(mixed_workload_generator(
        args.steps, lba_range,
        write_ratio=args.mix_ratio,
        zipf_alpha=args.zipf_alpha,
        seed=args.seed
    ))
    steps = build_write_steps(lbas, batch_size=args.batch, desc_prefix="混合")
    return build_script(
        f"混合负载(Zipf={args.mix_ratio:.0%}, 均匀={1-args.mix_ratio:.0%})",
        f"混合负载: {args.mix_ratio:.0%} Zipf(alpha={args.zipf_alpha}) + {1-args.mix_ratio:.0%} 均匀分布，"
        f"共{args.steps}次写入，批次大小={args.batch}",
        steps, lba_range
    )


def gen_gc_stress_script(args):
    """
    生成GC压力测试脚本
    流程: 填盘 → 反复覆写热点 → 触发GC → 验证
    """
    steps = []

    # 阶段1: 填满用户空间
    steps.append({
        "type": "sequential",
        "count": args.user_pages,
        "desc": f"阶段1: 顺序写入{args.user_pages}页填满用户空间"
    })

    # 阶段2: 热点覆写制造无效页
    hot_count = args.gc_hot_writes
    steps.append({
        "type": "overwrite",
        "lba": args.gc_hot_lba_start,
        "count": hot_count,
        "desc": f"阶段2: 覆写LBA {args.gc_hot_lba_start} 共{hot_count}次(制造无效页)"
    })

    steps.append({
        "type": "overwrite",
        "lba": args.gc_hot_lba_start + 1,
        "count": hot_count,
        "desc": f"阶段2: 覆写LBA {args.gc_hot_lba_start+1} 共{hot_count}次"
    })

    # 阶段3: 继续写入触发GC
    steps.append({
        "type": "sequential",
        "count": args.gc_fill_pages,
        "desc": f"阶段3: 继续写入{args.gc_fill_pages}页(应触发GC)"
    })

    # 阶段4: 再写入一些验证GC后的空间可用
    steps.append({
        "type": "random",
        "count": args.gc_post_writes,
        "range": [args.min_lba, args.max_lba],
        "desc": f"阶段4: GC后随机写入{args.gc_post_writes}页(验证空间)"
    })

    # 断言
    steps.append({
        "type": "assert_gc_count",
        "op": ">=",
        "value": 1,
        "desc": "断言: GC至少触发1次"
    })

    return build_script(
        "GC压力测试",
        f"填盘→覆写热点→触发GC→验证空间。用户空间={args.user_pages}页, OP={args.op_pages}页",
        steps, (args.min_lba, args.max_lba)
    )


# ======================== 命令行接口 ========================

def create_parser():
    parser = argparse.ArgumentParser(
        description='SSD GC Simulator 脚本生成器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 生成100步均匀随机写入
  python gen_script.py -o random.json --type uniform --steps 100

  # 生成500步Zipf热点写入(alpha=1.5)
  python gen_script.py -o zipf.json --type zipf --steps 500 --zipf-alpha 1.5

  # 热点区域写入(LBA 1-20和50-70为热点)
  python gen_script.py -o hotspot.json --type hotspot --hotspots "1,20:50,70"

  # 混合负载(70% Zipf + 30% 均匀)
  python gen_script.py -o mixed.json --type mixed --steps 300 --mix-ratio 0.7

  # GC压力测试
  python gen_script.py -o gc_stress.json --type gc_stress --gc-fill
        """
    )

    # 通用参数
    parser.add_argument('-o', '--output', default='script_output.json',
                        help='输出文件路径 (默认: script_output.json)')
    parser.add_argument('-t', '--type', default='uniform',
                        choices=['uniform', 'zipf', 'hotspot', 'sequential', 'mixed', 'gc_stress'],
                        help='脚本类型 (默认: uniform)')
    parser.add_argument('-s', '--steps', type=int, default=100,
                        help='写入步数 (默认: 100)')
    parser.add_argument('--min-lba', type=int, default=1,
                        help='最小LBA (默认: 1)')
    parser.add_argument('--max-lba', type=int, default=180,
                        help='最大LBA (默认: 180)')
    parser.add_argument('--batch', type=int, default=1,
                        help='每步写入页数 (默认: 1，1=单步单页)')
    parser.add_argument('--seed', type=int, default=None,
                        help='随机种子 (可选，用于可复现的结果)')
    parser.add_argument('--pretty', action='store_true', default=True,
                        help='美化JSON输出 (默认: 开启)')

    # Zipf参数
    parser.add_argument('--zipf-alpha', type=float, default=1.2,
                        help='Zipf分布的alpha参数 (默认: 1.2)')

    # Hotspot参数
    parser.add_argument('--hotspots', type=str,
                        default='1,10:80,90',
                        help='热点区间，格式: "lo1,hi1:lo2,hi2" (默认: "1,10:80,90")')
    parser.add_argument('--hot-prob', type=float, default=0.8,
                        help='访问热点区域的概率 (默认: 0.8)')

    # Sequential参数
    parser.add_argument('--seq-start', type=int, default=1,
                        help='顺序写入起始LBA (默认: 1)')

    # Mixed参数
    parser.add_argument('--mix-ratio', type=float, default=0.7,
                        help='Zipf分布占比 (默认: 0.7)')

    # GC Stress参数
    parser.add_argument('--user-pages', type=int, default=144,
                        help='用户空间页数 (默认: 144)')
    parser.add_argument('--op-pages', type=int, default=36,
                        help='OP空间页数 (默认: 36)')
    parser.add_argument('--gc-hot-writes', type=int, default=20,
                        help='GC测试热点覆写次数 (默认: 20)')
    parser.add_argument('--gc-hot-lba-start', type=int, default=1,
                        help='GC测试热点起始LBA (默认: 1)')
    parser.add_argument('--gc-fill-pages', type=int, default=36,
                        help='GC测试触发写入页数 (默认: 36)')
    parser.add_argument('--gc-post-writes', type=int, default=20,
                        help='GC后验证写入页数 (默认: 20)')

    return parser


def main():
    parser = create_parser()
    args = parser.parse_args()

    # 根据类型调用对应的生成函数
    generators = {
        'uniform': gen_uniform_random_script,
        'zipf': gen_zipf_script,
        'hotspot': gen_hotspot_script,
        'sequential': gen_sequential_script,
        'mixed': gen_mixed_script,
        'gc_stress': gen_gc_stress_script,
    }

    generator = generators.get(args.type)
    if not generator:
        print(f"错误: 未知脚本类型 '{args.type}'")
        return 1

    script = generator(args)

    # 输出到文件
    output_path = args.output
    with open(output_path, 'w', encoding='utf-8') as f:
        indent = 2 if args.pretty else None
        json.dump(script, f, ensure_ascii=False, indent=indent)

    step_count = len(script['steps'])
    print(f"[OK] 脚本已生成: {output_path}")
    print(f"     名称: {script['name']}")
    print(f"     总步数: {step_count}")
    print(f"     说明: {script['description'][:80]}...")

    # 显示统计信息
    write_steps = [s for s in script['steps'] if s['type'] in ('write', 'batch_write')]
    total_lbas = sum(len(s.get('lbas', [s.get('lba', 0)])) for s in write_steps)
    if 'lbas' in (write_steps[0] if write_steps else {}):
        total_lbas = sum(len(s['lbas']) for s in write_steps if s['type'] == 'batch_write')
        total_lbas += sum(1 for s in write_steps if s['type'] == 'write')
    print(f"     写入操作: {len(write_steps)} 步, 共 {total_lbas} 个LBA写入")
    print(f"\n将脚本文件导入模拟器即可执行。")

    return 0


if __name__ == '__main__':
    main()
