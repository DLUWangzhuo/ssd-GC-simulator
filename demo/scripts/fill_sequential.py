#!/usr/bin/env python3
"""
全盘顺序填充脚本生成器

生成一个JSON脚本，对SSD模拟器执行全盘顺序写入填充。
写入数量 = 用户空间页数 + OP空间页数，确保物理盘被完全填满。

关键行为：
1. 一次性使用 sequential 写入所有页（模拟器会自动处理PSB切换）
2. 填满物理盘后会触发GC

默认参数对应模拟器默认配置：
  - 6 Super Blocks × 4 Die × 9 Page = 216 总页
  - OP空间 = 1 SB = 36 页
  - 用户空间 = 5 SB = 180 页
  - 全盘 = 216 页

用法:
    python fill_sequential.py --output seq_fill.json
    python fill_sequential.py --total-pages 216 --output seq_fill.json
    python fill_sequential.py --total-pages 216 --divide 36 --output seq_fill_sb.json
"""

import json
import argparse


# ======================== 脚本构建框架 ========================

class ScriptBuilder:
    """
    脚本构建器，提供简化的LBA操作接口。
    用户只需要在 user_operations() 中调用 ctx.write() / ctx.sequential() 等接口，
    无需关注JSON结构、步骤描述、断言生成、文件写入等细节。
    """

    def __init__(self, user_pages=180):
        self.steps = []
        self.user_pages = user_pages
        self.sequential_lba = 1  # 顺序写入LBA指针

    def write(self, lba, desc=None):
        """添加一个 write 步骤"""
        if desc is None:
            desc = f"写入 LBA {lba}"
        self.steps.append({"type": "write", "lba": lba, "desc": desc})

    def sequential(self, count, desc=None):
        """添加一个 sequential 步骤"""
        if desc is None:
            desc = f"顺序写入{count}页 (LBA {self.sequential_lba}起)"
        self.steps.append({"type": "sequential", "count": count, "desc": desc})
        # 更新顺序指针（供描述使用）
        self.sequential_lba = (self.sequential_lba + count - 1) % self.user_pages + 1

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


def generate_script(user_operations_fn, total_pages, divide_by=None, name=None,
                    assert_write_count=True):
    """
    通用脚本生成入口。
    user_operations 只需写LBA操作，断言由本函数自动添加。

    Args:
        user_operations_fn: 用户操作函数，接收 ctx (ScriptBuilder) 参数
        total_pages: 写入的总页数
        divide_by: 可选，分批写入粒度。None=逐LBA写入，>0=按粒度分批
        name: 脚本名称
        assert_write_count: 是否自动添加写入计数断言（默认开启）

    Returns:
        dict: 脚本JSON对象
    """
    ctx = ScriptBuilder(user_pages=180)

    if divide_by and divide_by > 0:
        # 按指定粒度分批写入（无需 user_operations 操心）
        remaining = total_pages
        current_lba = 1
        batch_no = 1
        while remaining > 0:
            batch = min(divide_by, remaining)
            ctx.sequential(
                batch,
                desc=f"第{batch_no}批: 顺序写入{batch}页 (LBA {current_lba}起)"
            )
            remaining -= batch
            current_lba = (current_lba + batch - 1) % ctx.user_pages + 1
            batch_no += 1
    else:
        user_operations_fn(ctx, total_pages=total_pages)

    # 自动添加断言（可选）
    if assert_write_count:
        ctx.assert_write_count("==", total_pages, desc=f"验证用户写入次数 = {total_pages}")

    return ctx.build(
        name=name or f"写入共 ({total_pages}页)",
        description=f"对SSD模拟器执行{total_pages}页的全盘顺序写入填充"
                    f"\n写入方式: 逐LBA单步写入"
                    f"\n全盘容量: {total_pages}页 | LBA范围: 1-{ctx.user_pages}"
    )


# ======================== 用户操作层 ========================

def user_operations(ctx, total_pages=216):
    """
    用户操作入口 —— 只写LBA操作，不写断言。
    断言由 generate_script 自动添加（可通过参数关闭）。

    可用的 ctx 接口:
        ctx.write(lba, desc?)         — 写入单个LBA
        ctx.sequential(count, desc?)  — 顺序写入N个LBA
        ctx.gc(desc?)                 — 触发GC
        ctx.wait(ms, desc?)           — 等待

    Args:
        ctx: ScriptBuilder 实例
        total_pages: 写入总页数
    """
    for i in range(total_pages):
        lba = (i % ctx.user_pages) + 1
        ctx.write(
            lba,
            desc=f"顺序写入 LBA {lba} ({i + 1}/{total_pages})"
        )


# ======================== 旧接口兼容 ========================

def build_sequential_fill_script(total_pages, divide_by=None, name=None):
    """
    旧版接口 —— 保持向后兼容。
    内部调用新的 user_operations 框架。
    """
    return generate_script(
        user_operations_fn=user_operations,
        total_pages=total_pages,
        divide_by=divide_by,
        name=name
    )


# ======================== 命令行接口 ========================

def main():
    parser = argparse.ArgumentParser(
        description='全盘顺序填充脚本生成器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 一次性写入216页
  python fill_sequential.py -o seq_fill_all.json

  # 按SB粒度分步写入(36页/步)，便于观察
  python fill_sequential.py -o seq_fill_sb.json --divide 36

  # 自定义容量：10SB × 36页/SB = 360页
  python fill_sequential.py -o seq_fill_360.json --total-pages 360 --divide 36
        """
    )
    parser.add_argument('-o', '--output', default='seq_fill_all.json',
                        help='输出文件路径')
    parser.add_argument('--total-pages', type=int, default=216,
                        help='物理盘总页数 (默认: 216 = 6SB×4Die×9Page)')
    parser.add_argument('--divide', type=int, default=0,
                        help='分批写入粒度，0=一次性写入 (默认: 0)')
    parser.add_argument('--name', type=str, default=None,
                        help='脚本名称 (可选)')

    args = parser.parse_args()

    script = generate_script(
        user_operations_fn=user_operations,
        total_pages=args.total_pages,
        divide_by=args.divide if args.divide > 0 else None,
        name=args.name
    )

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(script, f, ensure_ascii=False, indent=2)

    step_count = len(script['steps'])
    total_write = args.total_pages
    divide_info = f" (分{step_count - 1}步, {args.divide}页/步)" if args.divide > 0 else " (一次性)"
    print(f"[OK] 全盘顺序填充脚本已生成: {args.output}")
    print(f"     名称: {script['name']}")
    print(f"     写入总量: {total_write} 页{divide_info}")
    print(f"     总步数: {step_count} 步(含断言)")
    print(f"     将脚本文件导入模拟器的\"脚本执行\"模式即可运行")


if __name__ == '__main__':
    main()
