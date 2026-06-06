#!/usr/bin/env python3
"""
用户操作接口 —— 只写 LBA 操作，不写框架代码。

用法 1（预设例程）：
    python user_operation.py                                 # 用户自定义
    python user_operation.py --type random                   # 随机填充全盘
    python user_operation.py --type sprandom                 # SPRandom 单遍快速预处理
    python user_operation.py --type sprandom --regions 20    # SPRandom 自定义区域数
    python user_operation.py --type random --seed 42         # 可复现随机填充

用法 2（自定义操作 — 编辑下方 user_operations 函数）：
    from user_operation import generate_sequential_script, user_operations
    script = generate_sequential_script(user_operations, total_pages=216)

用法 3（自定义预设）：
    from user_operation import sprandom_fill, generate_sequential_script
    script = generate_sequential_script(sprandom_fill, total_pages=216)
"""

import json
import argparse
import random
import inspect
from fill_sequential import ScriptBuilder, generate_script as generate_sequential_script
from fill_random import generate_script as generate_random_script


# ====================================================================
#  用户操作入口 —— 在这里编写自定义 LBA 操作
#  可用 ctx 接口:
#    ctx.write(lba, desc?)              写入单个 LBA
#    ctx.sequential(count, desc?)       顺序写入 N 个 LBA
#    ctx.gc(desc?)                      触发 GC
#    ctx.wait(ms, desc?)                等待
#    ctx.assert_write_count(op, value)  断言写入次数
#    ctx.assert_gc_count(op, value)     断言 GC 触发次数
#    ctx.assert_free_pages(op, value)   断言空闲页数
# ====================================================================

def user_operations(ctx, total_pages=720):
    """
    自定义操作 —— 按需修改此函数。

    Args:
        ctx: ScriptBuilder 实例
        total_pages: 写入总页数
    """
    # for i in range(total_pages):
    #     lba = (i % ctx.user_pages) + 1
    #     ctx.write(lba, desc=f"写入 LBA {lba} ({i + 1}/{total_pages})")

    PSB_SIZE = 36   #物理 super block size（单位page）
    TOTAL_SIZE = 20*PSB_SIZE
    OP_SIZE = 4*PSB_SIZE
    USER_SIZE = TOTAL_SIZE - OP_SIZE

    OP_RATIO = OP_SIZE/TOTAL_SIZE   # OP空间占比（OP容量/物理容量）
    

    REGION = 10







# ====================================================================
#  预设例程（开箱即用）
# ====================================================================

def sequential_fill_all(ctx, total_pages=720):
    """
    预设 1：顺序写满物理全盘（用户空间 + OP 空间）。
    每页一条 write 指令，LBA 从 1 到 user_pages 循环。
    """
    for i in range(total_pages):
        lba = (i % ctx.user_pages) + 1
        ctx.write(lba, desc=f"顺序写入 LBA {lba} ({i + 1}/{total_pages})")


def random_fill_all(ctx, total_pages=720, user_pages=576):
    """
    预设 2：随机写满物理全盘（用户空间 + OP 空间）。
    每页一条 write 指令，LBA 在 [1, user_pages] 内均匀随机。
    """
    for i in range(total_pages):
        lba = random.randint(1, user_pages)
        ctx.write(lba, desc=f"随机写入 LBA {lba} ({i + 1}/{total_pages})")


def random_fill_multi_round(ctx, total_pages=720, user_pages=576):
    """
    预设 3：一轮随机填充，配合 generate_random_script(rounds=2) 使用。
    此函数只写一轮，多轮逻辑由框架层的 rounds 参数处理。
    """
    for i in range(total_pages):
        lba = random.randint(1, user_pages)
        ctx.write(lba, desc=f"随机写入 LBA {lba} ({i + 1}/{total_pages})")


def _tapered_overlaps(num_regions, total_overlap):
    """
    计算递减的区域间重叠量。

    将 total_overlap 分配到 num_regions-1 个区域边界上，
    早期边界重叠大，后期边界重叠小（Desnoyers 分布启发式近似）。

    返回长度为 num_regions-1 的整数列表。
    """
    if num_regions <= 1 or total_overlap <= 0:
        return [0] * max(0, num_regions - 1)

    # 权重：从 N-1 递减到 1
    weights = list(range(num_regions - 1, 0, -1))
    total_weight = num_regions * (num_regions - 1) / 2

    overlaps = []
    remaining = total_overlap
    for w in weights:
        o = min(remaining, max(1, round(total_overlap * w / total_weight)))
        overlaps.append(o)
        remaining -= o

    # 余数归入最大重叠（最左边）
    if remaining > 0:
        overlaps[0] += remaining

    return overlaps


def sprandom_fill(ctx, total_pages=720, user_pages=576, num_regions=20):
    """
    SPRandom（SanDisk Pseudo-Random Fast Preconditioning）预设。

    在单次遍历中完成填盘和稳态分布模拟，大幅减少预处理时间。
    基于 SNIA 2025 论文 "Deterministic, Fast, Random Preconditioning Using Sprandom"。

    算法原理：
    1. 将物理容量（用户页 + OP 页）均分为 N 个区域
    2. 每个区域内，所覆盖的 LBA 以伪随机（洗牌）顺序写入
    3. 相邻区域之间有重叠，重叠量由 OP 比例决定
    4. 早期区域重叠更大（Desnoyers 分布），形成 tapered invalidation
    5. 经过 1 遍写入即模拟出稳态的无效页分布，等效于传统的
       顺序填盘 + 多轮随机写入

    总写入量 = 用户页 + OP 页 = 物理容量
    每 LBA 至少写入 1 次，部分 LBA 被覆写（重叠区域）产生无效页。

    参数:
        ctx: ScriptBuilder 实例
        total_pages: 物理盘总页数（默认 216）
        user_pages: 用户空间页数（默认 180）
        num_regions: 区域数（默认 10，更大 → 更细粒度分布）
    """
    L = user_pages
    P = total_pages
    N = num_regions
    OP = P - L  # OP 页数

    # 每区域写入量：均分 P，余数分布在前几个区域
    sizes = [P // N + (1 if i < P % N else 0) for i in range(N)]

    if N <= 1:
        for lba in range(1, L + 1):
            ctx.write(lba, desc=f"SPRandom LBA {lba}")
        return

    # 递减重叠量：早期区域重叠大，后期重叠小
    overlaps = _tapered_overlaps(N, OP)

    # 逐区域写入
    start = 1  # 区域 0 从 LBA 1 开始
    for i in range(N):
        size = sizes[i]

        # 该区域覆盖的 LBA 范围：[start, start+size)，模 L 环绕
        lbas = [((start - 1 + j) % L) + 1 for j in range(size)]

        # 区域内随机打乱（伪随机顺序）
        random.shuffle(lbas)
        for lba in lbas:
            ctx.write(lba, desc=f"SPRandom R{i+1}/{N} LBA {lba}")

        # 计算下一个区域的起始 LBA
        if i < N - 1:
            shift = size - overlaps[i]
            start = ((start - 1 + shift) % L) + 1


# ====================================================================
#  命令行：直接用预设生成脚本
# ====================================================================

def main():
    parser = argparse.ArgumentParser(description="用户操作脚本生成器")
    parser.add_argument("--type", choices=["seq", "random", "sprandom"], default="seq",
                        help="预设类型: seq=顺序填充, random=随机填充, sprandom=SPRandom单遍预处理 (默认: seq)")
    parser.add_argument("--total-pages", type=int, default=None,
                        help=f"物理盘总页数 (默认: {inspect.signature(sprandom_fill).parameters['total_pages'].default})")
    parser.add_argument("--user-pages", type=int, default=None,
                        help=f"用户空间页数 (默认: {inspect.signature(sprandom_fill).parameters['user_pages'].default}，仅 random/sprandom 类型有效)")
    parser.add_argument("--rounds", type=int, default=2,
                        help="写入轮数 (默认: 2，仅 random 类型有效)")
    parser.add_argument("--seed", type=int, default=None,
                        help="随机种子 (默认: 随机，仅 random 类型有效)")
    parser.add_argument("--divide", type=int, default=0,
                        help="分批粒度 (默认: 0=不分批，仅 seq 类型有效)")
    parser.add_argument("--regions", type=int, default=None,
                        help=f"SPRandom 区域数 (默认: {inspect.signature(sprandom_fill).parameters['num_regions'].default}，仅 sprandom 类型有效)")
    parser.add_argument("-o", "--output", default=None,
                        help="输出文件路径 (默认: 自动生成)")
    args = parser.parse_args()

    if args.type == "seq":
        _total = args.total_pages if args.total_pages is not None else inspect.signature(sequential_fill_all).parameters['total_pages'].default
        output = args.output or f"seq_fill_{_total}pages.json"
        script = generate_sequential_script(
            sequential_fill_all,
            total_pages=_total,
            divide_by=args.divide if args.divide > 0 else None
        )
        print(f"[OK] 顺序填充脚本已生成: {output}")

    elif args.type == "sprandom":
        _total = args.total_pages if args.total_pages is not None else inspect.signature(sprandom_fill).parameters['total_pages'].default
        _user = args.user_pages if args.user_pages is not None else inspect.signature(sprandom_fill).parameters['user_pages'].default
        _regions = args.regions if args.regions is not None else inspect.signature(sprandom_fill).parameters['num_regions'].default
        output = args.output or f"sprandom_fill_{_total}pages_{_regions}regions.json"

        from fill_sequential import ScriptBuilder as SeqBuilder
        ctx = SeqBuilder(user_pages=_user)

        if args.seed is not None:
            random.seed(args.seed)

        sprandom_fill(ctx, total_pages=_total,
                      user_pages=_user, num_regions=_regions)

        ctx.assert_write_count("==", _total,
                               desc=f"验证用户写入次数 = {_total}")

        script = ctx.build(
            name=f"SPRandom 预处理 ({_total}页, {_regions}区域)",
            description=(
                f"SPRandom 单遍快速预处理模拟器"
                f"\n算法: 物理容量={_total}页 | 用户={_user}页 | OP={_total-_user}页"
                f"\n区域: {_regions}个 | 重叠分布: Desnoyers递减免"
                f"\n一次遍历同时完成填盘与稳态分布模拟"
            )
        )
        seed_info = f", 种子={args.seed}" if args.seed is not None else ""
        print(f"[OK] SPRandom 预处理脚本已生成: {output} ({_regions}区域{seed_info})")

    else:  # random
        _total = args.total_pages if args.total_pages is not None else inspect.signature(random_fill_multi_round).parameters['total_pages'].default
        _user = args.user_pages if args.user_pages is not None else inspect.signature(random_fill_multi_round).parameters['user_pages'].default
        output = args.output or f"rand_fill_{_total}pages_{args.rounds}rounds.json"
        script = generate_random_script(
            random_fill_multi_round,
            total_pages=_total,
            user_pages=_user,
            rounds=args.rounds,
            seed=args.seed
        )
        seed_info = f", 种子={args.seed}" if args.seed is not None else ""
        print(f"[OK] 随机填充脚本已生成: {output} ({args.rounds}轮{seed_info})")

    with open(output, "w", encoding="utf-8") as f:
        json.dump(script, f, ensure_ascii=False, indent=2)

    print(f"     名称: {script['name']}")
    print(f"     总步数: {len(script['steps'])} 步")


if __name__ == "__main__":
    main()
