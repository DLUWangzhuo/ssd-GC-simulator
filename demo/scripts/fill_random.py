#!/usr/bin/env python3
"""
全盘随机填充脚本生成器

生成一个JSON脚本，对SSD模拟器执行全盘随机写入填充。
写入数量 = 用户空间页数 + OP空间页数，确保物理盘被完全填满并触发GC。

关键行为：
1. 使用 random 指令写入指定数量的LBA
2. LBA范围覆盖用户空间 (1 ~ userPages)
3. 允许多轮随机覆写，制造大量无效页确保GC触发
4. 模拟真实SSD使用场景：随机写入 + 覆写

默认参数对应模拟器默认配置：
  - 用户空间 = 180 页，OP空间 = 36 页
  - 全盘物理容量 = 216 页

用法:
    python fill_random.py --output rand_fill.json
    python fill_random.py --total-pages 216 --rounds 3 --output rand_fill_3r.json
    python fill_random.py --user-space 180 --op-space 36 --output rand_fill_custom.json
"""

import json
import random
import argparse


# ======================== 脚本构建框架 ========================

class ScriptBuilder:
    """
    脚本构建器，提供简化的LBA操作接口。
    用户只需要在 user_operations() 中调用 ctx.write() 等接口，
    无需关注JSON结构、步骤描述、断言生成、文件写入等细节。
    """

    def __init__(self, user_pages=180):
        self.steps = []
        self.user_pages = user_pages

    def write(self, lba, desc=None):
        """添加一个 write 步骤"""
        if desc is None:
            desc = f"写入 LBA {lba}"
        self.steps.append({"type": "write", "lba": lba, "desc": desc})

    def sequential(self, count, desc=None):
        """添加一个 sequential 步骤"""
        if desc is None:
            desc = f"顺序写入{count}页"
        self.steps.append({"type": "sequential", "count": count, "desc": desc})

    def gc(self, desc=None):
        """添加GC触发步骤"""
        self.steps.append({"type": "gc", "desc": desc or "触发GC"})

    def wait(self, ms, desc=None):
        """添加等待步骤"""
        if desc is None:
            desc = f"等待{ms}ms"
        self.steps.append({"type": "wait", "ms": ms, "desc": desc})

    def assert_write_count(self, op, value, desc=None):
        """添加写入计数断言"""
        if desc is None:
            desc = f"验证用户写入次数 {op} {value}"
        self.steps.append({"type": "assert_write_count", "op": op, "value": value, "desc": desc})

    def assert_gc_count(self, op, value, desc=None):
        """添加GC触发次数断言"""
        if desc is None:
            desc = f"验证GC触发次数 {op} {value}"
        self.steps.append({"type": "assert_gc_count", "op": op, "value": value, "desc": desc})

    def assert_free_pages(self, op, value, desc=None):
        """添加空闲页断言"""
        if desc is None:
            desc = f"验证空闲页数 {op} {value}"
        self.steps.append({"type": "assert_free_pages", "op": op, "value": value, "desc": desc})

    def get_steps(self):
        """获取所有步骤"""
        return self.steps

    def build(self, name, description=""):
        """构建完整的脚本字典"""
        return {
            "name": name,
            "description": description,
            "steps": self.steps
        }


def generate_script(user_operations_fn, total_pages, user_pages,
                     rounds=2, lbas_per_round=None, seed=None, name=None):
    """
    通用脚本生成入口。
    user_operations 只需写LBA操作，seed 和轮次循环由本函数处理。

    Args:
        user_operations_fn: 用户操作函数，接收 ctx (ScriptBuilder) 参数
        total_pages: 写入的总页数
        user_pages: 用户空间页数（LBA范围上限）
        rounds: 写入轮数
        lbas_per_round: 每轮写入页数，None则自动分配
        seed: 随机种子（框架层自动调用 random.seed，user_operations 无需关心）
        name: 脚本名称

    Returns:
        dict: 脚本JSON对象
    """
    if lbas_per_round is None:
        if rounds <= 1:
            lbas_per_round = [total_pages]
        else:
            # 自动分配：第一轮填满用户空间，后续每轮覆写总页数/轮数
            lbas_per_round = [user_pages] + [(total_pages - user_pages) // (rounds - 1)] * (rounds - 1)
            # 调整确保总量正确
            diff = total_pages - sum(lbas_per_round)
            if diff > 0 and len(lbas_per_round) > 1:
                lbas_per_round[-1] += diff
            elif diff > 0:
                lbas_per_round[0] += diff

    if seed is not None:
        random.seed(seed)

    ctx = ScriptBuilder(user_pages=user_pages)

    # 框架层按轮次循环，user_operations 只需关注 LBA 写入
    for count in lbas_per_round:
        if count <= 0:
            continue
        user_operations_fn(ctx, total_pages=count, user_pages=user_pages)

    # 自动添加断言
    # 当存在覆写（total_pages > user_pages）且有多轮时，检查GC被触发
    if total_pages > user_pages and rounds >= 2:
        ctx.assert_gc_count(">=", 1, desc="验证GC至少触发1次")
    ctx.assert_write_count(">=", total_pages, desc=f"验证用户写入次数 >= {total_pages}")

    seed_note = f" | 随机种子: {seed}" if seed is not None else ""
    name_str = name or f"全盘随机填充 ({total_pages}页, {rounds}轮)"
    desc = (f"对SSD模拟器执行{total_pages}页的全盘随机写入填充"
            f"\n写入方式: 逐LBA随机写入+覆写，触发GC回收"
            f"\n全盘容量: {total_pages}页 | 用户空间: {user_pages}页 | LBA范围: 1-{user_pages} | 轮数: {rounds}"
            f"\n每轮写入: {', '.join(str(c) for c in lbas_per_round if c > 0)} 页"
            f"{seed_note}")
    return ctx.build(name=name_str, description=desc)


# ======================== 用户操作层 ========================

def user_operations(ctx, total_pages=216, user_pages=180):
    """
    用户操作入口 —— 只写LBA操作，不写断言。
    seed 和轮次循环由 generate_script 框架层处理。

    可用的 ctx 接口:
        ctx.write(lba, desc?)         — 写入单个LBA
        ctx.sequential(count, desc?)  — 顺序写入N个LBA
        ctx.gc(desc?)                 — 触发GC
        ctx.wait(ms, desc?)           — 等待

    Args:
        ctx: ScriptBuilder 实例
        total_pages: 写入总页数
        user_pages: 用户空间页数（LBA范围上限）
    """
    for i in range(total_pages):
        lba = random.randint(1, user_pages)
        ctx.write(
            lba,
            desc=f"随机写入 LBA {lba} ({i + 1}/{total_pages})"
        )


# ======================== 旧接口兼容 ========================

def build_random_fill_script(total_pages, user_pages, rounds=2, lbas_per_round=None,
                              seed=None, name=None):
    """
    旧版接口 —— 保持向后兼容。
    内部调用新的 user_operations 框架。
    """
    return generate_script(
        user_operations_fn=user_operations,
        total_pages=total_pages,
        user_pages=user_pages,
        rounds=rounds,
        lbas_per_round=lbas_per_round,
        seed=seed,
        name=name
    )


# ======================== 命令行接口 ========================

def main():
    parser = argparse.ArgumentParser(
        description='全盘随机填充脚本生成器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 默认配置：2轮随机写入，总量216页
  python fill_random.py -o rand_fill.json

  # 3轮随机写入，更容易触发GC
  python fill_random.py --rounds 3 -o rand_fill_3r.json

  # 指定固定随机种子（可复现结果）
  python fill_random.py --seed 42 -o rand_fill_deterministic.json

  # 自定义容量
  python fill_random.py --user-space 144 --op-space 72 --rounds 2 -o rand_fill_custom.json
        """
    )
    parser.add_argument('-o', '--output', default='rand_fill.json',
                        help='输出文件路径')
    parser.add_argument('--total-pages', type=int, default=216,
                        help='物理盘总页数 (默认: 216)')
    parser.add_argument('--user-space', type=int, default=180,
                        help='用户空间页数，也是LBA范围上限 (默认: 180)')
    parser.add_argument('--rounds', type=int, default=2,
                        help='写入轮数 (默认: 2。第1轮填盘，后续轮覆写制造无效页)')
    parser.add_argument('--seed', type=int, default=None,
                        help='随机种子，用于可复现的结果')
    parser.add_argument('--name', type=str, default=None,
                        help='脚本名称 (可选)')

    args = parser.parse_args()

    script = generate_script(
        user_operations_fn=user_operations,
        total_pages=args.total_pages,
        user_pages=args.user_space,
        rounds=args.rounds,
        seed=args.seed,
        name=args.name
    )

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(script, f, ensure_ascii=False, indent=2)

    step_count = len(script['steps'])
    print(f"[OK] 全盘随机填充脚本已生成: {args.output}")
    print(f"     名称: {script['name']}")
    print(f"     写入总量: {args.total_pages} 页, {args.rounds} 轮")
    print(f"     总步数: {step_count} 步(含断言)")
    print(f"     将脚本文件导入模拟器的\"脚本执行\"模式即可运行")


if __name__ == '__main__':
    main()
