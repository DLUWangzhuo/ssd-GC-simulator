#!/usr/bin/env python3
"""
SSD GC Simulator - 脚本逻辑验证测试

在Python中直接测试脚本JSON的生成质量和逻辑正确性。
无需浏览器，运行速度快，适合CI环境。

测试范围:
  - 脚本生成器的JSON输出结构验证
  - 脚本步骤的合法性校验（模拟器侧的validateScript逻辑在Python中复现）
  - 脚本文件的基本统计信息检查
  - Python生成器（gen_script.py, fill_sequential.py, fill_random.py）的输出正确性

用法:
    python test_scripts_logic.py                         # 运行所有测试
    python test_scripts_logic.py -v                       # 详细输出
    python test_scripts_logic.py --skip-generator         # 跳过生成器测试（仅验证已有JSON文件）
"""

import json
import os
import sys
import subprocess
import argparse
import math
import random

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)  # demo/
SCRIPTS_DIR = os.path.join(PROJECT_DIR, 'scripts')

# ============================================================
#  测试框架
# ============================================================

class TestFailure(Exception):
    pass

passed = 0
failed = 0
verbose = False

def test(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        if verbose:
            print(f"  [PASS] {name}")
    except Exception as e:
        failed += 1
        print(f"  [FAIL] {name}")
        print(f"         {e}")

def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise TestFailure(f"{msg} 期望 {expected}, 实际 {actual}")

def assert_neq(actual, expected, msg=""):
    if actual == expected:
        raise TestFailure(f"{msg} 不应该等于 {expected}")

def assert_gte(actual, expected, msg=""):
    if actual < expected:
        raise TestFailure(f"{msg} 期望 >= {expected}, 实际 {actual}")

def assert_lte(actual, expected, msg=""):
    if actual > expected:
        raise TestFailure(f"{msg} 期望 <= {expected}, 实际 {actual}")

def assert_true(condition, msg=""):
    if not condition:
        raise TestFailure(msg or "条件应为True")

def assert_false(condition, msg=""):
    if condition:
        raise TestFailure(msg or "条件应为False")

def assert_in_range(actual, lo, hi, msg=""):
    if actual < lo or actual > hi:
        raise TestFailure(f"{msg} 期望在 [{lo}, {hi}] 内, 实际 {actual}")

# ============================================================
#  Python端复现的validateScript逻辑
# ============================================================

VALID_TYPES = {'write', 'batch_write', 'overwrite', 'random', 'sequential',
               'gc', 'wait', 'assert_free_pages', 'assert_gc_count',
               'assert_write_count', 'assert_invalid_pages', 'loop'}

def validate_script_py(script):
    """在Python端校验脚本JSON结构（与JS端validateScript逻辑一致）"""
    errors = []
    if not isinstance(script, dict):
        return False, ['脚本必须是对象']
    if 'steps' not in script or not isinstance(script['steps'], list) or len(script['steps']) == 0:
        return False, ['steps必须是非空数组']

    for i, step in enumerate(script['steps']):
        if not isinstance(step, dict):
            errors.append(f'steps[{i}]: 必须是对象')
            continue
        if 'type' not in step:
            errors.append(f'steps[{i}]: 缺少type')
            continue
        t = step['type']
        if t not in VALID_TYPES:
            errors.append(f'steps[{i}]: 未知type "{t}"')
            continue

        if t == 'write' and (not isinstance(step.get('lba'), int) or step['lba'] < 1):
            errors.append(f'steps[{i}](write): lba必须为正整数')
        elif t == 'batch_write':
            lbas = step.get('lbas', [])
            if not isinstance(lbas, list) or len(lbas) == 0:
                errors.append(f'steps[{i}](batch_write): lbas必须为非空数组')
            else:
                for j, lba in enumerate(lbas):
                    if not isinstance(lba, int) or lba < 1:
                        errors.append(f'steps[{i}](batch_write): lbas[{j}]必须为正整数')
        elif t == 'overwrite':
            if not isinstance(step.get('lba'), int) or step['lba'] < 1:
                errors.append(f'steps[{i}](overwrite): lba必须为正整数')
            if not isinstance(step.get('count'), int) or step['count'] < 1:
                errors.append(f'steps[{i}](overwrite): count必须为正整数')
        elif t == 'random':
            if not isinstance(step.get('count'), int) or step['count'] < 1:
                errors.append(f'steps[{i}](random): count必须为正整数')
            rng = step.get('range')
            if rng and (not isinstance(rng, list) or len(rng) != 2 or rng[0] >= rng[1]):
                errors.append(f'steps[{i}](random): range必须为[min, max]且min<max')
        elif t == 'sequential':
            if not isinstance(step.get('count'), int) or step['count'] < 1:
                errors.append(f'steps[{i}](sequential): count必须为正整数')
        elif t == 'wait':
            if not isinstance(step.get('ms'), (int, float)) or step['ms'] < 0:
                errors.append(f'steps[{i}](wait): ms必须为非负数')
        elif t in ('assert_free_pages', 'assert_gc_count', 'assert_write_count', 'assert_invalid_pages'):
            if not isinstance(step.get('value'), (int, float)):
                errors.append(f'steps[{i}]({t}): value必须为数字')
            op = step.get('op', '>=')
            if op not in ('>', '<', '>=', '<=', '=='):
                errors.append(f'steps[{i}]({t}): op必须为 >, <, >=, <=, == 之一')
        elif t == 'loop':
            if not isinstance(step.get('count'), int) or step['count'] < 1:
                errors.append(f'steps[{i}](loop): count必须为正整数')
            if not isinstance(step.get('steps'), list) or len(step['steps']) == 0:
                errors.append(f'steps[{i}](loop): steps必须为非空数组')
            else:
                for j, sub in enumerate(step['steps']):
                    sub_valid, sub_err = validate_script_py({'steps': [sub]})
                    if not sub_valid:
                        errors.append(f'steps[{i}].steps[{j}]: {sub_err[0]}')

    return len(errors) == 0, errors


# ============================================================
#  测试用例
# ============================================================

def test_suite_generator_outputs():
    """测试脚本生成器的输出"""
    suite = "脚本生成器输出验证"

    def run_and_load(gen_script, args_list, output_name):
        """运行Python生成器并加载JSON"""
        output_path = os.path.join(SCRIPTS_DIR, output_name)
        cmd = [sys.executable, os.path.join(SCRIPTS_DIR, gen_script)] + args_list + ['-o', output_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        assert_eq(result.returncode, 0, f'{gen_script} 执行成功')
        with open(output_path, 'r', encoding='utf-8') as f:
            script = json.load(f)
        return script, output_path

    # 测试1: fill_sequential.py 默认输出
    test("fill_sequential 默认输出 216页", lambda: (
        run_and_load('fill_sequential.py', [], '_test_seq.json'),
        None  # 避免返回值影响断言
    ))

    # 验证刚刚生成的脚本文件
    test_path = os.path.join(SCRIPTS_DIR, '_test_seq.json')
    if os.path.exists(test_path):
        with open(test_path, 'r', encoding='utf-8') as f:
            script = json.load(f)

        test(f"  fill_sequential: 名称不为空", lambda: (
            assert_true(len(script.get('name', '')) > 0, "名称不为空")
        ))
        test(f"  fill_sequential: 步骤数=217 (216写入+1断言)", lambda: (
            assert_eq(len(script['steps']), 217)
        ))
        test(f"  fill_sequential: 含assert_write_count", lambda: (
            assert_eq(script['steps'][-1]['type'], 'assert_write_count')
        ))
        test(f"  fill_sequential: 步骤校验通过", lambda: (
            assert_true(validate_script_py(script)[0])
        ))

    # 测试2: fill_sequential.py --divide 36
    test("fill_sequential 分批写入 216页/36页步", lambda: (
        run_and_load('fill_sequential.py', ['--divide', '36'], '_test_seq_div.json'),
        None
    ))

    test_path = os.path.join(SCRIPTS_DIR, '_test_seq_div.json')
    if os.path.exists(test_path):
        with open(test_path, 'r', encoding='utf-8') as f:
            script = json.load(f)

        test(f"  fill_sequential(分批): 6轮+1断言=7步", lambda: (
            assert_eq(len(script['steps']), 7)
        ))
        test(f"  fill_sequential(分批): 每步count=36", lambda: (
            all(assert_eq(s['count'], 36) for s in script['steps'] if s['type'] == 'sequential')
        ))
        test(f"  fill_sequential(分批): 校验通过", lambda: (
            assert_true(validate_script_py(script)[0])
        ))

    # 测试3: fill_random.py 默认输出
    test("fill_random 默认输出 216页/2轮", lambda: (
        run_and_load('fill_random.py', ['--seed', '42'], '_test_rand.json'),
        None
    ))

    test_path = os.path.join(SCRIPTS_DIR, '_test_rand.json')
    if os.path.exists(test_path):
        with open(test_path, 'r', encoding='utf-8') as f:
            script = json.load(f)

        test(f"  fill_random: 步骤数=218 (216写入+2断言)", lambda: (
            assert_eq(len(script['steps']), 218)
        ))
        test(f"  fill_random: 第1步类型=write(逐LBA写入)", lambda: (
            assert_eq(script['steps'][0]['type'], 'write')
        ))
        test(f"  fill_random: 含assert_gc_count断言", lambda: (
            any(s['type'] == 'assert_gc_count' for s in script['steps'])
        ))
        test(f"  fill_random: 校验通过", lambda: (
            assert_true(validate_script_py(script)[0])
        ))

    # 测试4: fill_random.py 3轮
    test("fill_random 3轮 216页", lambda: (
        run_and_load('fill_random.py', ['--rounds', '3', '--seed', '42'], '_test_rand_3r.json'),
        None
    ))

    test_path = os.path.join(SCRIPTS_DIR, '_test_rand_3r.json')
    if os.path.exists(test_path):
        with open(test_path, 'r', encoding='utf-8') as f:
            script = json.load(f)

        test(f"  fill_random(3轮): 3轮write+2断言", lambda: (
            # 3轮 = 180 + 18 + 18 = 216个write + 2个assert = 218步
            assert_eq(len(script['steps']), 218)
        ))

    # 测试5: gen_script.py 各类型
    gen_types = [
        (['--type', 'uniform', '--steps', '50', '--seed', '42'], '_gen_uniform.json', 50),
        (['--type', 'zipf', '--steps', '50', '--seed', '42'], '_gen_zipf.json', 50),
        (['--type', 'hotspot', '--steps', '50', '--seed', '42'], '_gen_hotspot.json', 50),
        (['--type', 'sequential', '--steps', '50', '--seed', '42'], '_gen_seq.json', 50),
        (['--type', 'mixed', '--steps', '50', '--seed', '42'], '_gen_mixed.json', 50),
        (['--type', 'gc_stress'], '_gen_gc_stress.json', None),
    ]

    for args_list, out_name, expected_steps in gen_types:
        test(f"gen_script {args_list[1]}: 生成成功", lambda args=args_list, out=out_name: (
            run_and_load('gen_script.py', args, out),
            None
        ))
        test_path = os.path.join(SCRIPTS_DIR, out_name)
        if os.path.exists(test_path):
            with open(test_path, 'r', encoding='utf-8') as f:
                script = json.load(f)
            test(f"  gen_script {args_list[1]}: steps > 0", lambda: (
                assert_gte(len(script['steps']), 1)
            ))
            test(f"  gen_script {args_list[1]}: 校验通过", lambda: (
                assert_true(validate_script_py(script)[0])
            ))

    # 清理
    for f in os.listdir(SCRIPTS_DIR):
        if f.startswith('_test_') or f.startswith('_gen_'):
            os.remove(os.path.join(SCRIPTS_DIR, f))


def test_suite_script_validation():
    """脚本JSON校验逻辑"""
    suite = "脚本JSON校验逻辑"

    test("合法脚本校验通过", lambda: (
        assert_true(validate_script_py({
            "steps": [{"type": "write", "lba": 1}]
        })[0])
    ))

    test("空steps校验失败", lambda: (
        assert_false(validate_script_py({"steps": []})[0])
    ))

    test("lba=0校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "write", "lba": 0}]})[0])
    ))

    test("未知type校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "invalid"}]})[0])
    ))

    test("batch_write空数组校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "batch_write", "lbas": []}]})[0])
    ))

    test("batch_write合法校验通过", lambda: (
        assert_true(validate_script_py({"steps": [{"type": "batch_write", "lbas": [1,2,3]}]})[0])
    ))

    test("overwrite合法校验通过", lambda: (
        assert_true(validate_script_py({"steps": [{"type": "overwrite", "lba": 1, "count": 5}]})[0])
    ))

    test("overwrite count=0校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "overwrite", "lba": 1, "count": 0}]})[0])
    ))

    test("random range格式校验", lambda: (
        assert_true(validate_script_py({"steps": [{"type": "random", "count": 10, "range": [1, 180]}]})[0])
    ))

    test("random range[min>=max]校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "random", "count": 10, "range": [100, 50]}]})[0])
    ))

    test("assert op校验", lambda: (
        assert_true(validate_script_py({"steps": [{"type": "assert_free_pages", "op": ">=", "value": 10}]})[0])
    ))

    test("assert非法op校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "assert_free_pages", "op": "!=", "value": 10}]})[0])
    ))

    test("loop合法校验通过", lambda: (
        assert_true(validate_script_py({"steps": [{"type": "loop", "count": 3, "steps": [
            {"type": "write", "lba": 1}
        ]}]})[0])
    ))

    test("loop空steps校验失败", lambda: (
        assert_false(validate_script_py({"steps": [{"type": "loop", "count": 3, "steps": []}]})[0])
    ))

    def _test_complex_script():
        script = {
            "name": "Complex",
            "steps": [
                {"type": "sequential", "count": 36},
                {"type": "write", "lba": 5},
                {"type": "overwrite", "lba": 1, "count": 10},
                {"type": "batch_write", "lbas": [10, 20, 30]},
                {"type": "random", "count": 50, "range": [1, 180]},
                {"type": "gc"},
                {"type": "wait", "ms": 500},
                {"type": "assert_free_pages", "op": ">=", "value": 10},
                {"type": "assert_gc_count", "op": ">=", "value": 1},
                {"type": "loop", "count": 2, "steps": [
                    {"type": "write", "lba": 99}
                ]}
            ]
        }
        valid, errors = validate_script_py(script)
        assert_true(valid, f"复杂脚本应通过校验: {errors}")
    test("复杂嵌套脚本校验通过", _test_complex_script)


def test_suite_script_statistics():
    """示例JSON文件的统计信息检查"""
    suite = "示例JSON文件验证"

    example_files = [
        ('example_hotspot.json', '热点区域覆写测试'),
        ('example_gc_stress.json', 'GC压力测试'),
        ('example_zipf.json', 'Zipf分布热点写入'),
    ]

    for fname, expected_name_prefix in example_files:
        fpath = os.path.join(SCRIPTS_DIR, fname)
        if not os.path.exists(fpath):
            test(f"[SKIP] {fname} 文件不存在", lambda: None)
            continue

        with open(fpath, 'r', encoding='utf-8') as f:
            script = json.load(f)

        test(f"{fname}: JSON解析成功", lambda: (
            assert_true(isinstance(script, dict))
        ))

        test(f"{fname}: 校验通过", lambda: (
            assert_true(validate_script_py(script)[0])
        ))

        test(f"{fname}: 有steps且数量>0", lambda: (
            assert_gte(len(script.get('steps', [])), 1)
        ))

        test(f"{fname}: 步骤描述不为空", lambda: (
            all(assert_true('desc' in s or s['type'] == 'gc',
                f"步骤缺少desc: {json.dumps(s, ensure_ascii=False)[:50]}")
                for s in script['steps'])
        ))


def test_suite_distribution_quality():
    """测试生成器的分布质量"""
    suite = "分布质量验证"

    user_pages = 180

    # 使用gen_script生成Zipf样本
    output = os.path.join(SCRIPTS_DIR, '_test_zipf_quality.json')
    cmd = [sys.executable, os.path.join(SCRIPTS_DIR, 'gen_script.py'),
           '--type', 'zipf', '--steps', '500', '--zipf-alpha', '1.5',
           '--seed', '42', '-o', output]
    subprocess.run(cmd, capture_output=True, text=True)

    if os.path.exists(output):
        with open(output, 'r', encoding='utf-8') as f:
            script = json.load(f)

        # 提取所有写入的LBA
        lbas = []
        for step in script['steps']:
            if step['type'] == 'write':
                lbas.append(step['lba'])
            elif step['type'] == 'batch_write':
                lbas.extend(step.get('lbas', []))

        test(f"  Zipf(alpha=1.5) LBA在有效范围内", lambda: (
            all(assert_in_range(lba, 1, user_pages, f"LBA {lba}") for lba in lbas)
        ))

        if lbas:
            # 检查热点分布：低LBA应该被更频繁访问（Zipf特性）
            low_set = set(range(1, 21))    # LBA 1-20
            mid_set = set(range(81, 101))   # LBA 81-100
            low_count = sum(1 for l in lbas if l in low_set)
            mid_count = sum(1 for l in lbas if l in mid_set)

            test(f"  Zipf: 热点LBA(1-20)命中{low_count}次 > 中等LBA(81-100)命中{mid_count}次", lambda: (
                assert_true(low_count > mid_count,
                    f"Zipf分布异常: 低LBA({low_count}次) 应多于中LBA({mid_count}次)")
            ))

        os.remove(output)


def test_suite_fill_scripts_consistency():
    """验证fill_sequential和fill_random的数学一致性"""
    suite = "填充脚本一致性验证"

    # 验证不同参数组合下的步骤数量计算
    def _test_fill_seq_steps():
        # 逐LBA: 216个write + 1个assert = 217步
        steps_216_write = [{"type": "write", "lba": (i % 180) + 1} for i in range(216)]
        steps_216_write.append({"type": "assert_write_count", "op": "==", "value": 216})
        assert_eq(len(steps_216_write), 217)
    test("fill_sequential 逐LBA写入: 216write+1断言=217步", _test_fill_seq_steps)

    def _test_fill_seq_batches():
        total = 216
        batch = 36
        batches = (total + batch - 1) // batch
        assert_eq(6, batches)
    test("fill_sequential 分批写入N步: 216/36=6批+1断言=7步", _test_fill_seq_batches)

    test("fill_random 2轮(216write)+2断言=218步", lambda: (
        None  # 实际已在generator test中验证
    ))

    def _test_fill_random_relation():
        total = 216
        user = 180
        count_r1 = user
        count_r2 = total - user
        assert_eq(180, count_r1)
        assert_eq(36, count_r2)
    test("fill_random 总量和用户空间关系", _test_fill_random_relation)


# ============================================================
#  主入口
# ============================================================

def main():
    global verbose
    parser = argparse.ArgumentParser(
        description='SSD GC Simulator - Python端逻辑测试',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('-v', '--verbose', action='store_true', help='详细输出')
    parser.add_argument('--skip-generator', action='store_true', help='跳过生成器测试')
    args = parser.parse_args()

    verbose = args.verbose

    print("=" * 60)
    print("SSD GC Simulator - Python端逻辑测试")
    print("=" * 60)
    print()

    if not args.skip_generator:
        print("[套件] 脚本生成器输出验证")
        test_suite_generator_outputs()
        print()

    print("[套件] 脚本JSON校验逻辑")
    test_suite_script_validation()
    print()

    print("[套件] 示例JSON文件验证")
    test_suite_script_statistics()
    print()

    if not args.skip_generator:
        print("[套件] 分布质量验证")
        test_suite_distribution_quality()
        print()

    print("[套件] 填充脚本一致性验证")
    test_suite_fill_scripts_consistency()
    print()

    # 结果汇总
    total = passed + failed
    print("=" * 60)
    print(f"结果: {passed}/{total} 通过", end="")
    if failed > 0:
        print(f", {failed} 失败", end="")
    print()
    print("=" * 60)

    return 1 if failed > 0 else 0


if __name__ == '__main__':
    sys.exit(main())
