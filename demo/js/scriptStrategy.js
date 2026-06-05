/**
 * 脚本策略模块
 * 负责JSON脚本的解析、校验、单步/多步执行
 *
 * 脚本JSON格式:
 * {
 *   "name": "脚本名称",
 *   "description": "脚本描述",
 *   "steps": [
 *     { "type": "write",     "lba": 1,                        "desc": "写入单个LBA" },
 *     { "type": "batch_write", "lbas": [1,2,3],               "desc": "批量写入" },
 *     { "type": "overwrite", "lba": 1, "count": 5,            "desc": "覆写N次" },
 *     { "type": "random",    "count": 10, "range": [1,180],   "desc": "随机写入" },
 *     { "type": "sequential","count": 36,                     "desc": "顺序写入" },
 *     { "type": "gc",                                         "desc": "触发GC" },
 *     { "type": "wait",      "ms": 500,                       "desc": "等待" },
 *     { "type": "assert_free_pages", "op": ">=", "value": 10, "desc": "断言空闲页" },
 *     { "type": "assert_gc_count",   "op": ">=", "value": 1,  "desc": "断言GC次数" },
 *     { "type": "assert_write_count","op": ">=", "value": 10, "desc": "断言写入次数" },
 *     { "type": "assert_invalid_pages", "op": ">=", "value": 5, "desc": "断言无效页数" },
 *     { "type": "loop", "count": 3, "steps": [...],           "desc": "循环3次" }
 *   ]
 * }
 */

(function() {
    'use strict';

    // ============ 脚本状态 ============
    let scriptState = {
        loaded: false,                // 是否已加载脚本
        name: '',
        description: '',
        steps: [],                    // 展开后的steps（loop已展开）
        currentIndex: 0,              // 当前执行到的步骤索引
        totalSteps: 0,
        isRunning: false,             // 是否正在多步执行中
        abortFlag: false,             // 中止标志
        autoGC: true,                 // 脚本执行中是否自动处理GC弹窗
        speed: 5,                      // 执行速度 0(慢)~10(快/skip)
        logs: [],
        stepResults: []               // 每步的执行结果
    };

    // ============ 校验 ============

    /**
     * 校验脚本JSON结构
     * @param {object} script - 解析后的脚本对象
     * @returns {object} {valid: boolean, errors: string[]}
     */
    function validateScript(script) {
        const errors = [];
        if (!script || typeof script !== 'object') {
            return { valid: false, errors: ['脚本必须是一个JSON对象'] };
        }
        if (!Array.isArray(script.steps) || script.steps.length === 0) {
            return { valid: false, errors: ['steps必须是一个非空数组'] };
        }

        // 验证每个step
        for (let i = 0; i < script.steps.length; i++) {
            const step = script.steps[i];
            const stepErrors = validateStep(step, i);
            errors.push(...stepErrors);
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * 校验单个step
     */
    function validateStep(step, index) {
        const prefix = `steps[${index}]`;
        const errors = [];
        if (!step || typeof step !== 'object') {
            errors.push(`${prefix}: 必须是对象`);
            return errors;
        }
        if (!step.type) {
            errors.push(`${prefix}: 缺少type字段`);
            return errors;
        }

        const validTypes = ['write', 'batch_write', 'overwrite', 'random', 'sequential', 'gc', 'wait', 'assert_free_pages', 'assert_gc_count', 'assert_write_count', 'assert_invalid_pages', 'loop'];
        if (!validTypes.includes(step.type)) {
            errors.push(`${prefix}: 未知type "${step.type}"，有效值: ${validTypes.join(', ')}`);
            return errors;
        }

        switch (step.type) {
            case 'write':
                if (typeof step.lba !== 'number' || step.lba < 1) {
                    errors.push(`${prefix}(write): lba必须为正整数`);
                }
                break;
            case 'batch_write':
                if (!Array.isArray(step.lbas) || step.lbas.length === 0) {
                    errors.push(`${prefix}(batch_write): lbas必须为非空数组`);
                } else {
                    step.lbas.forEach((lba, j) => {
                        if (typeof lba !== 'number' || lba < 1) {
                            errors.push(`${prefix}(batch_write): lbas[${j}]必须为正整数`);
                        }
                    });
                }
                break;
            case 'overwrite':
                if (typeof step.lba !== 'number' || step.lba < 1) {
                    errors.push(`${prefix}(overwrite): lba必须为正整数`);
                }
                if (typeof step.count !== 'number' || step.count < 1) {
                    errors.push(`${prefix}(overwrite): count必须为正整数`);
                }
                break;
            case 'random':
                if (typeof step.count !== 'number' || step.count < 1) {
                    errors.push(`${prefix}(random): count必须为正整数`);
                }
                if (step.range && (!Array.isArray(step.range) || step.range.length !== 2 || step.range[0] >= step.range[1])) {
                    errors.push(`${prefix}(random): range必须为[min, max]且min < max`);
                }
                break;
            case 'sequential':
                if (typeof step.count !== 'number' || step.count < 1) {
                    errors.push(`${prefix}(sequential): count必须为正整数`);
                }
                break;
            case 'wait':
                if (typeof step.ms !== 'number' || step.ms < 0) {
                    errors.push(`${prefix}(wait): ms必须为非负数`);
                }
                break;
            case 'assert_free_pages':
            case 'assert_gc_count':
            case 'assert_write_count':
            case 'assert_invalid_pages':
                if (typeof step.value !== 'number') {
                    errors.push(`${prefix}(${step.type}): value必须为数字`);
                }
                if (step.op && !['>', '<', '>=', '<=', '=='].includes(step.op)) {
                    errors.push(`${prefix}(${step.type}): op必须为 >, <, >=, <=, == 之一`);
                }
                break;
            case 'loop':
                if (typeof step.count !== 'number' || step.count < 1) {
                    errors.push(`${prefix}(loop): count必须为正整数`);
                }
                if (!Array.isArray(step.steps) || step.steps.length === 0) {
                    errors.push(`${prefix}(loop): steps必须为非空数组`);
                } else {
                    step.steps.forEach((subStep, j) => {
                        const subErrors = validateStep(subStep, `${index}.steps[${j}]`);
                        errors.push(...subErrors);
                    });
                }
                break;
        }
        return errors;
    }

    // ============ 展开 ============

    /**
     * 展开脚本（将loop展开为扁平steps）
     */
    function expandSteps(steps) {
        const result = [];
        steps.forEach((step, i) => {
            if (step.type === 'loop') {
                for (let c = 0; c < step.count; c++) {
                    step.steps.forEach(subStep => {
                        result.push({
                            ...subStep,
                            // 记录来源以便显示
                            _loopInfo: `循环 ${i + 1}/${steps.length} (第${c + 1}/${step.count}轮)`,
                            _originalDesc: subStep.desc || ''
                        });
                    });
                }
            } else {
                result.push({ ...step });
            }
        });
        return result;
    }

    // ============ 执行 ============

    /**
     * 执行单个step（同步执行，wait类型会返回延迟时间）
     * @param {object} step - 步骤对象
     * @param {number} stepIndex - 步骤索引（用于日志）
     * @returns {object} { success, delay, message, breakFlag }
     */
    function executeStep(step, stepIndex) {
        const sim = window.SSDSimulator;
        const { ssdState, state, utils, writeStrategy, gc } = sim;

        if (!step || !step.type) {
            return { success: false, delay: 0, message: `步骤${stepIndex}: 无效步骤`, breakFlag: false };
        }

        // 检查当前PSB是否有空闲页（仅对写入类操作需要检查）
        function checkPsbSpace() {
            const freeInCurrentPsb = state.getSuperBlockPages(ssdState.currentPsb)
                .filter(p => p.state === 'empty').length;
            if (freeInCurrentPsb === 0) {
                const bestPsb = state.selectBestPsb();
                if (bestPsb !== -1 && bestPsb !== ssdState.currentPsb) {
                    ssdState.currentPsb = bestPsb;
                    return true;
                }
                return false;
            }
            return true;
        }

        let resultMessage = '';

        switch (step.type) {
            case 'write': {
                const lba = step.lba;
                if (!checkPsbSpace()) {
                    return { success: false, delay: 0, message: `步骤${stepIndex}: 无空闲页，写入LBA ${lba} 失败`, breakFlag: true };
                }
                // 先检查是否需要GC
                const freePagesCount = state.getFreePagesCount();
                if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
                    // GC会被自动触发，但脚本模式下做特殊处理
                }
                const writeResult = writeStrategy.writeSingleLba(lba, true);
                if (writeResult) {
                    resultMessage = `写入 LBA ${lba} → SB${writeResult.sb} Die${writeResult.die} Page${writeResult.page}`;
                } else {
                    resultMessage = `写入 LBA ${lba} 失败（无空闲页）`;
                }
                return { success: !!writeResult, delay: 0, message: step.desc || resultMessage, breakFlag: !writeResult };
            }

            case 'batch_write': {
                const lbas = step.lbas;
                const results = [];
                let allSuccess = true;
                for (const lba of lbas) {
                    if (!checkPsbSpace()) {
                        results.push(`LBA ${lba}: 失败(无空闲页)`);
                        allSuccess = false;
                        break;
                    }
                    const wr = writeStrategy.writeSingleLba(lba, false);
                    if (wr) {
                        results.push(`LBA ${lba} → SB${wr.sb} Die${wr.die} Page${wr.page}`);
                    } else {
                        results.push(`LBA ${lba}: 失败`);
                        allSuccess = false;
                        break;
                    }
                }
                // 统一渲染
                state.saveState();
                sim.renderer.renderSSD();
                utils.updateStatus();
                sim.renderer.updateMappingTable();
                sim.renderer.updateBlockStatsPanel();
                resultMessage = `批量写入 ${lbas.length} 页: ${results.join('; ')}`;
                return { success: allSuccess, delay: 0, message: step.desc || resultMessage, breakFlag: !allSuccess };
            }

            case 'overwrite': {
                const lba = step.lba;
                const count = step.count;
                let successCount = 0;
                for (let i = 0; i < count; i++) {
                    if (!checkPsbSpace()) {
                        break;
                    }
                    const wr = writeStrategy.writeSingleLba(lba, false);
                    if (wr) successCount++;
                    else break;
                }
                // 统一渲染
                state.saveState();
                sim.renderer.renderSSD();
                utils.updateStatus();
                sim.renderer.updateMappingTable();
                sim.renderer.updateBlockStatsPanel();
                resultMessage = `覆写 LBA ${lba} ${successCount}/${count} 次`;
                return { success: successCount > 0, delay: 0, message: step.desc || resultMessage, breakFlag: successCount < count };
            }

            case 'random': {
                const count = step.count;
                const range = step.range || [1, CONFIG.userPages];
                let successCount = 0;
                for (let i = 0; i < count; i++) {
                    if (!checkPsbSpace()) break;
                    const lba = Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
                    const wr = writeStrategy.writeSingleLba(lba, false);
                    if (wr) successCount++;
                    else break;
                }
                state.saveState();
                sim.renderer.renderSSD();
                utils.updateStatus();
                sim.renderer.updateMappingTable();
                sim.renderer.updateBlockStatsPanel();
                resultMessage = `随机写入 ${successCount}/${count} 页 (LBA范围 ${range[0]}-${range[1]})`;
                return { success: successCount > 0, delay: 0, message: step.desc || resultMessage, breakFlag: successCount < count };
            }

            case 'sequential': {
                const count = step.count;
                let remaining = count;
                let totalWritten = 0;
                let failed = false;
                // sequentialWrite 每次仅写当前PSB的空闲页数（最多36页），
                // 需要循环调用直到写满要求的数量或物理盘存满
                //
                // 使用 writeStrategy.sequentialWrite() 而非逐页 writeSingleLba，
                // 因为 sequentialWrite 内部正确处理了：
                //   - LBA顺序递增（sequentialLpa指针）
                //   - LBA溢出时回绕到1
                //   - 完整日志输出
                //   - 写入页高亮
                while (remaining > 0) {
                    const freePages = state.getFreePagesCount();
                    if (freePages === 0) {
                        failed = true;
                        break;
                    }
                    const currentPsbFree = state.getSuperBlockPages(ssdState.currentPsb)
                        .filter(p => p.state === 'empty').length;
                    if (currentPsbFree === 0) {
                        const bestPsb = state.selectBestPsb();
                        if (bestPsb !== -1 && bestPsb !== ssdState.currentPsb) {
                            ssdState.currentPsb = bestPsb;
                        } else {
                            failed = true;
                            break;
                        }
                    }
                    // 每次写入当前PSB能容纳的量
                    const writeCount = Math.min(remaining, state.getSuperBlockPages(ssdState.currentPsb)
                        .filter(p => p.state === 'empty').length);
                    if (writeCount <= 0) {
                        failed = true;
                        break;
                    }
                    writeStrategy.sequentialWrite(writeCount);
                    totalWritten += writeCount;
                    remaining -= writeCount;
                }
                resultMessage = `顺序写入 ${totalWritten}/${count} 页${failed ? (state.getInvalidPagesCount() > 0 ? ' (空间满，需GC)' : ' (物理盘已存满)') : ''}`;
                return { success: totalWritten > 0, delay: 0, message: step.desc || resultMessage, breakFlag: failed };
            }

            case 'gc': {
                gc.triggerGC();
                resultMessage = '触发GC';
                return { success: true, delay: 0, message: step.desc || resultMessage, breakFlag: false };
            }

            case 'wait': {
                return { success: true, delay: step.ms || 0, message: step.desc || `等待 ${step.ms}ms`, breakFlag: false };
            }

            case 'assert_free_pages': {
                const actual = state.getFreePagesCount();
                const op = step.op || '>=';
                const ok = compareOp(actual, op, step.value);
                resultMessage = `断言空闲页: 当前=${actual}, ${op} ${step.value} → ${ok ? '通过' : '失败'}`;
                return { success: ok, delay: 0, message: step.desc || resultMessage, breakFlag: !ok };
            }

            case 'assert_gc_count': {
                const actual = ssdState.gcTriggerCount;
                const op = step.op || '>=';
                const ok = compareOp(actual, op, step.value);
                resultMessage = `断言GC次数: 当前=${actual}, ${op} ${step.value} → ${ok ? '通过' : '失败'}`;
                return { success: ok, delay: 0, message: step.desc || resultMessage, breakFlag: !ok };
            }

            case 'assert_write_count': {
                const actual = ssdState.userWriteCount;
                const op = step.op || '>=';
                const ok = compareOp(actual, op, step.value);
                resultMessage = `断言写入次数: 当前=${actual}, ${op} ${step.value} → ${ok ? '通过' : '失败'}`;
                return { success: ok, delay: 0, message: step.desc || resultMessage, breakFlag: !ok };
            }

            case 'assert_invalid_pages': {
                const actual = state.getInvalidPagesCount();
                const op = step.op || '>=';
                const ok = compareOp(actual, op, step.value);
                resultMessage = `断言无效页数: 当前=${actual}, ${op} ${step.value} → ${ok ? '通过' : '失败'}`;
                return { success: ok, delay: 0, message: step.desc || resultMessage, breakFlag: !ok };
            }

            default:
                return { success: false, delay: 0, message: `步骤${stepIndex}: 未知类型 "${step.type}"`, breakFlag: true };
        }
    }

    /**
     * 比较操作
     */
    function compareOp(actual, op, expected) {
        switch (op) {
            case '>': return actual > expected;
            case '<': return actual < expected;
            case '>=': return actual >= expected;
            case '<=': return actual <= expected;
            case '==': return actual === expected;
            default: return actual >= expected;
        }
    }

    /**
     * 计算步骤延迟（基于速度滑块）
     */
    function getStepDelay() {
        const val = scriptState.speed;
        if (val >= 10) return 0; // 跳过/最快
        return Math.round(300 / (val + 1)); // 0→300ms, 9→30ms
    }

    /**
     * 处理GC弹窗（自动模式下）
     * 先确认GC触发弹窗（如果有），再快速完成GC步骤
     * @returns {Promise}
     */
    function handleGCPopup() {
        return new Promise((resolve) => {
            if (!scriptState.autoGC) {
                resolve();
                return;
            }

            const gcTriggerOverlay = document.getElementById('gcTriggerOverlay');
            const gcStepOverlay = document.getElementById('gcOverlay');

            // 情况1: GC触发确认弹窗正在显示
            if (gcTriggerOverlay && gcTriggerOverlay.classList.contains('active')) {
                // 确认GC（这会关闭触发弹窗并打开GC步骤弹窗）
                if (typeof window.gcTriggerConfirm === 'function') {
                    window.gcTriggerConfirm();
                }
                // 等一小段时间让GC步骤弹窗出现，然后快速完成
                setTimeout(() => {
                    completeGCFast().then(resolve);
                }, 50);
                return;
            }

            // 情况2: GC步骤弹窗正在显示（触发弹窗已被确认，或手动触发的GC）
            if (gcStepOverlay && gcStepOverlay.classList.contains('active')) {
                completeGCFast().then(resolve);
                return;
            }

            // 情况3: 无GC弹窗
            resolve();
        });
    }

    /**
     * 快速完成GC（跳过动画）
     * 设置GC动画速度为跳过模式，然后依次点击所有GC步骤完成按钮
     */
    function completeGCFast() {
        return new Promise((resolve) => {
            const gcStepOverlay = document.getElementById('gcOverlay');
            if (!gcStepOverlay || !gcStepOverlay.classList.contains('active')) {
                resolve();
                return;
            }

            // 先设置速度为跳过模式（使GC动画步骤瞬间完成）
            const speedSlider = document.getElementById('gcAnimSpeed');
            const prevSpeed = speedSlider ? speedSlider.value : 5;
            if (speedSlider) speedSlider.value = 10;

            // 自动执行GC步骤
            function stepThroughGC() {
                if (!gcStepOverlay.classList.contains('active')) {
                    // GC步骤弹窗已关闭，GC完成
                    if (speedSlider) speedSlider.value = prevSpeed;
                    resolve();
                    return;
                }

                const nextBtn = document.querySelector('#gcStepModal .btn-warning');
                if (nextBtn && !nextBtn.disabled) {
                    const btnText = nextBtn.textContent.trim();
                    if (btnText === '下一步' || btnText === '确认') {
                        // 跳过模式下动画瞬间完成，直接点击下一步
                        nextBtn.click();
                        // 继续处理后续GC步骤
                        setTimeout(stepThroughGC, 30);
                    } else {
                        // 按钮不可点击（如读取中/写回中），但在跳过模式下应该瞬间完成，重试
                        setTimeout(stepThroughGC, 30);
                    }
                } else {
                    setTimeout(stepThroughGC, 30);
                }
            }

            // 给GC步骤弹窗一点初始化时间
            setTimeout(stepThroughGC, 100);
        });
    }

    // ============ 公共API ============

    /**
     * 加载脚本
     * @param {object|string} script - 脚本对象或JSON字符串
     * @returns {object} {success, errors}
     */
    function loadScript(script) {
        let parsed;
        if (typeof script === 'string') {
            try {
                parsed = JSON.parse(script);
            } catch (e) {
                return { success: false, errors: [`JSON解析错误: ${e.message}`] };
            }
        } else {
            parsed = script;
        }

        const validation = validateScript(parsed);
        if (!validation.valid) {
            return { success: false, errors: validation.errors };
        }

        scriptState.name = parsed.name || '未命名脚本';
        scriptState.description = parsed.description || '';
        scriptState.steps = expandSteps(parsed.steps);
        scriptState.totalSteps = scriptState.steps.length;
        scriptState.currentIndex = 0;
        scriptState.loaded = true;
        scriptState.isRunning = false;
        scriptState.abortFlag = false;
        scriptState.logs = [];
        scriptState.stepResults = [];

        window.SSDSimulator.utils.addLog(`脚本加载: "${scriptState.name}" (${scriptState.totalSteps}步)`, 'write');

        return { success: true, errors: [] };
    }

    /**
     * 重置脚本执行（回到第0步，不重置SSD）
     */
    function resetExecution() {
        scriptState.currentIndex = 0;
        scriptState.isRunning = false;
        scriptState.abortFlag = false;
        scriptState.logs = [];
        scriptState.stepResults = [];
        updateUI();
    }

    /**
     * 同步处理GC弹窗（用于单步模式，同步确认+快速完成）
     * @returns {boolean} 是否处理了GC
     */
    function handleGCSync() {
        if (!scriptState.autoGC) return false;

        const gcTriggerOverlay = document.getElementById('gcTriggerOverlay');
        const gcStepOverlay = document.getElementById('gcOverlay');

        if (gcTriggerOverlay && gcTriggerOverlay.classList.contains('active')) {
            // 确认GC
            if (typeof window.gcTriggerConfirm === 'function') {
                window.gcTriggerConfirm();
            }
            // 快速完成GC步骤弹窗（如果有）
            completeGCFastSync();
            return true;
        } else if (gcStepOverlay && gcStepOverlay.classList.contains('active')) {
            completeGCFastSync();
            return true;
        }
        return false;
    }

    /**
     * 同步快速完成GC（跳过动画，用于单步模式）
     */
    function completeGCFastSync() {
        const gcStepOverlay = document.getElementById('gcOverlay');
        if (!gcStepOverlay || !gcStepOverlay.classList.contains('active')) return;

        // 设置速度为跳过模式
        const speedSlider = document.getElementById('gcAnimSpeed');
        if (speedSlider) speedSlider.value = 10;

        // 同步点击所有GC步骤直到完成
        let maxAttempts = 20;
        while (maxAttempts-- > 0) {
            if (!gcStepOverlay.classList.contains('active')) break;

            const nextBtn = document.querySelector('#gcStepModal .btn-warning');
            if (nextBtn && !nextBtn.disabled) {
                const btnText = nextBtn.textContent.trim();
                if (btnText === '下一步' || btnText === '确认') {
                    nextBtn.click();
                } else {
                    // 等待状态的步骤（读取中/写回中），短暂延迟后重试
                    break;
                }
            } else {
                break;
            }
        }

        // 恢复速度
        if (speedSlider) speedSlider.value = scriptState.speed;
    }

    /**
     * 执行单步
     * 注意: 这是同步函数，单步模式下GC弹窗同步处理
     * @param {boolean} fromMultiStep - 是否从多步执行中调用
     * @returns {object} 执行结果
     */
    function stepForward(fromMultiStep) {
        if (!scriptState.loaded) {
            return { success: false, message: '请先加载脚本', finished: true };
        }

        if (scriptState.currentIndex >= scriptState.totalSteps) {
            scriptState.isRunning = false;
            if (!fromMultiStep) {
                window.SSDSimulator.utils.addLog('脚本已全部执行完毕', 'gc');
            }
            return { success: true, message: '脚本已全部执行完毕', finished: true };
        }

        const step = scriptState.steps[scriptState.currentIndex];
        const result = executeStep(step, scriptState.currentIndex);

        // 记录结果
        scriptState.stepResults[scriptState.currentIndex] = result;
        scriptState.logs.push(`[${scriptState.currentIndex + 1}/${scriptState.totalSteps}] ${result.message}`);

        if (result.success) {
            window.SSDSimulator.utils.addLog(`[脚本] ${result.message}`, 'write');
        } else {
            window.SSDSimulator.utils.addLog(`[脚本] ⚠ ${result.message}`, 'gc');
        }

        // 单步模式下同步处理GC弹窗
        if (!fromMultiStep && scriptState.autoGC) {
            handleGCSync();
        }

        // 更新UI
        updateUI();

        // 非多步执行时才增加索引（多步执行由runSteps控制）
        if (!fromMultiStep) {
            scriptState.currentIndex++;
        }

        return { ...result, finished: scriptState.currentIndex >= scriptState.totalSteps };
    }

    /**
     * 执行N步
     * @param {number} count - 步数，-1表示全部
     * @param {function} onComplete - 完成回调
     */
    function runSteps(count, onComplete) {
        if (!scriptState.loaded) {
            window.SSDSimulator.utils.addLog('请先加载脚本', 'gc');
            return;
        }

        if (scriptState.isRunning) {
            window.SSDSimulator.utils.addLog('脚本正在执行中', 'gc');
            return;
        }

        const startIndex = scriptState.currentIndex;
        let stepsExecuted = 0;

        scriptState.isRunning = true;
        scriptState.abortFlag = false;
        updateUI();

        function doStep() {
            if (scriptState.abortFlag) {
                scriptState.isRunning = false;
                window.SSDSimulator.utils.addLog(`脚本执行中止 (已执行${stepsExecuted}步)`, 'gc');
                updateUI();
                if (onComplete) onComplete({ aborted: true, executed: stepsExecuted });
                return;
            }

            if (scriptState.currentIndex >= scriptState.totalSteps ||
                stepsExecuted >= (count === -1 ? Infinity : count)) {
                scriptState.isRunning = false;
                window.SSDSimulator.utils.addLog(`脚本执行完成 (${startIndex} → ${scriptState.currentIndex}, 共${stepsExecuted}步)`, 'write');
                updateUI();
                if (onComplete) onComplete({ aborted: false, executed: stepsExecuted });
                return;
            }

            const step = scriptState.steps[scriptState.currentIndex];
            const result = executeStep(step, scriptState.currentIndex);

            scriptState.stepResults[scriptState.currentIndex] = result;
            scriptState.logs.push(`[${scriptState.currentIndex + 1}/${scriptState.totalSteps}] ${result.message}`);

            if (result.success) {
                window.SSDSimulator.utils.addLog(`[脚本] ${result.message}`, 'write');
            } else {
                window.SSDSimulator.utils.addLog(`[脚本] ⚠ ${result.message}`, 'gc');
            }

            scriptState.currentIndex++;
            stepsExecuted++;

            // 更新UI（进度）
            updateUIStatus();

            // 处理GC弹窗（不论步骤成功或失败，只要autoGC开启就处理）
            if (scriptState.autoGC && !scriptState.abortFlag) {
                handleGCPopup(true).then(() => {
                    // GC处理完后，检查是否还需要继续
                    scheduleNextStep(stepsExecuted, count);
                });
            } else {
                scheduleNextStep(stepsExecuted, count);
            }
        }

        function scheduleNextStep(executed, totalCount) {
            if (scriptState.currentIndex >= scriptState.totalSteps ||
                executed >= (totalCount === -1 ? Infinity : totalCount)) {
                scriptState.isRunning = false;
                window.SSDSimulator.utils.addLog(`脚本执行完成 (${startIndex} → ${scriptState.currentIndex}, 共${executed}步)`, 'write');
                updateUI();
                if (onComplete) onComplete({ aborted: false, executed: executed });
                return;
            }
            const delay = (totalCount === -1 || executed < totalCount) ? getStepDelay() : 0;
            if (delay === 0) {
                doStep();
            } else {
                setTimeout(doStep, delay);
            }
        }

        doStep();
    }

    /**
     * 中止执行
     */
    function abort() {
        scriptState.abortFlag = true;
        scriptState.isRunning = false;
    }

    /**
     * 重置SSD并重置脚本（复位）
     */
    function resetAll() {
        if (confirm('确定要重置SSD和脚本执行吗？')) {
            window.SSDSimulator.state.resetSSD();
            resetExecution();
            window.SSDSimulator.utils.addLog('SSD和脚本已复位', 'gc');
        }
    }

    // ============ UI更新 ============

    /**
     * 更新脚本面板UI
     */
    function updateUI() {
        const currentEl = document.getElementById('scriptCurrentIndex');
        const totalEl = document.getElementById('scriptTotalSteps');
        const nameEl = document.getElementById('scriptName');
        const progressEl = document.getElementById('scriptProgress');
        const progressTextEl = document.getElementById('scriptProgressText');
        const runBtn = document.getElementById('scriptRunBtn');
        const stepBtn = document.getElementById('scriptStepBtn');
        const stopBtn = document.getElementById('scriptStopBtn');

        if (currentEl) currentEl.textContent = scriptState.currentIndex;
        if (totalEl) totalEl.textContent = scriptState.totalSteps;
        if (nameEl && scriptState.loaded) nameEl.textContent = scriptState.name;

        // 进度条
        if (progressEl && scriptState.totalSteps > 0) {
            const pct = Math.round((scriptState.currentIndex / scriptState.totalSteps) * 100);
            progressEl.style.width = pct + '%';
        }
        if (progressTextEl) {
            progressTextEl.textContent = `${scriptState.currentIndex} / ${scriptState.totalSteps}`;
        }

        // 按钮状态
        if (runBtn) runBtn.disabled = !scriptState.loaded || scriptState.isRunning || scriptState.currentIndex >= scriptState.totalSteps;
        if (stepBtn) stepBtn.disabled = !scriptState.loaded || scriptState.isRunning || scriptState.currentIndex >= scriptState.totalSteps;
        if (stopBtn) stopBtn.style.display = scriptState.isRunning ? 'inline-block' : 'none';

        // 更新日志
        updateLogPanel();
    }

    /**
     * 更新进度(仅数字，不更新按钮状态，多步执行使用)
     */
    function updateUIStatus() {
        const currentEl = document.getElementById('scriptCurrentIndex');
        const totalEl = document.getElementById('scriptTotalSteps');
        const progressEl = document.getElementById('scriptProgress');
        const progressTextEl = document.getElementById('scriptProgressText');

        if (currentEl) currentEl.textContent = scriptState.currentIndex;
        if (totalEl) totalEl.textContent = scriptState.totalSteps;
        if (progressEl && scriptState.totalSteps > 0) {
            const pct = Math.round((scriptState.currentIndex / scriptState.totalSteps) * 100);
            progressEl.style.width = pct + '%';
        }
        if (progressTextEl) {
            progressTextEl.textContent = `${scriptState.currentIndex} / ${scriptState.totalSteps}`;
        }
    }

    /**
     * 更新脚本日志面板
     */
    function updateLogPanel() {
        const container = document.getElementById('scriptLogContainer');
        if (!container) return;

        container.innerHTML = '';
        // 显示最近20条
        const logs = scriptState.logs.slice(-20);
        logs.forEach(log => {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            // 检测是否包含警告
            if (log.includes('⚠') || log.includes('失败')) {
                entry.classList.add('gc');
            } else {
                entry.classList.add('write');
            }
            entry.textContent = log;
            container.appendChild(entry);
        });
    }

    /**
     * 获取脚本状态快照
     */
    function getState() {
        return { ...scriptState };
    }

    // ============ 内置示例脚本 ============

    function getBuiltinScripts() {
        return [
            {
                name: '热点LBA覆写测试',
                description: '对LBA 1-5反复写入，制造大量无效页，触发GC',
                steps: [
                    { type: 'sequential', count: 180, desc: '填满全盘' },
                    { type: 'loop', count: 3, desc: '循环覆写3轮', steps: [
                        { type: 'write', lba: 1, desc: '覆写LBA 1' },
                        { type: 'write', lba: 2, desc: '覆写LBA 2' },
                        { type: 'write', lba: 3, desc: '覆写LBA 3' },
                        { type: 'write', lba: 4, desc: '覆写LBA 4' },
                        { type: 'write', lba: 5, desc: '覆写LBA 5' }
                    ]}
                ]
            },
            {
                name: 'GC触发验证',
                description: '写入→覆写→填满，验证GC自动触发的条件',
                steps: [
                    { type: 'sequential', count: 144, desc: '写入144页（填满用户空间）' },
                    { type: 'batch_write', lbas: [1,5,10,15,20,25,30,35,40], desc: '写入9个LBA（触发OP空间使用）' },
                    { type: 'overwrite', lba: 1, count: 10, desc: '覆写LBA 1 十次' },
                    { type: 'overwrite', lba: 50, count: 10, desc: '覆写LBA 50 十次' },
                    { type: 'overwrite', lba: 100, count: 10, desc: '覆写LBA 100 十次' },
                    { type: 'sequential', count: 36, desc: '继续写入填满空间（应触发GC）' }
                ]
            },
            {
                name: '随机写入压力测试',
                description: '全盘随机写入和覆写，观察GC的Write Age分布变化',
                steps: [
                    { type: 'sequential', count: 180, desc: '初始填满全盘' },
                    { type: 'random', count: 50, range: [1, 180], desc: '随机覆写50页' },
                    { type: 'random', count: 50, range: [1, 180], desc: '随机覆写50页' },
                    { type: 'random', count: 50, range: [1, 180], desc: '随机覆写50页' },
                    { type: 'sequential', count: 36, desc: '填满触发GC' },
                    { type: 'random', count: 100, range: [1, 180], desc: 'GC后继续随机写入' }
                ]
            },
            {
                name: '断言验证示例',
                description: '演示断言指令的使用方式',
                steps: [
                    { type: 'sequential', count: 36, desc: '顺序写入36页（1个SB）' },
                    { type: 'assert_free_pages', op: '==', value: 144, desc: '检查空闲页=144' },
                    { type: 'assert_write_count', op: '==', value: 36, desc: '检查写入计数=36' },
                    { type: 'write', lba: 1, desc: '写入LBA 1' },
                    { type: 'write', lba: 1, desc: '覆写LBA 1' },
                    { type: 'assert_invalid_pages', op: '==', value: 1, desc: '检查无效页=1' }
                ]
            },
            {
                name: '空盘基准测试',
                description: '按SB粒度逐步写入，观察整个过程',
                steps: [
                    { type: 'sequential', count: 36, desc: '写入SB0（36页）' },
                    { type: 'wait', ms: 300, desc: '停顿' },
                    { type: 'sequential', count: 36, desc: '写入SB1（36页）' },
                    { type: 'wait', ms: 300, desc: '停顿' },
                    { type: 'sequential', count: 36, desc: '写入SB2（36页）' },
                    { type: 'wait', ms: 300, desc: '停顿' },
                    { type: 'sequential', count: 36, desc: '写入SB3（36页）' },
                    { type: 'wait', ms: 300, desc: '停顿' },
                    { type: 'sequential', count: 36, desc: '写入SB4（36页，使用OP空间）' }
                ]
            }
        ];
    }

    // ============ 导入/导出 ============

    /**
     * 从文件加载脚本
     * @param {File} file
     * @returns {Promise}
     */
    function loadFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const result = loadScript(e.target.result);
                if (result.success) {
                    resolve(result);
                } else {
                    reject(result);
                }
            };
            reader.onerror = () => reject({ success: false, errors: ['文件读取失败'] });
            reader.readAsText(file);
        });
    }

    /**
     * 导出当前脚本为JSON文件
     */
    function exportScript() {
        if (!scriptState.loaded) {
            window.SSDSimulator.utils.addLog('没有已加载的脚本可导出', 'gc');
            return;
        }

        const data = {
            name: scriptState.name,
            description: scriptState.description,
            steps: scriptState.steps
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${scriptState.name}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // 导出模块
    window.SSDScriptStrategy = {
        // 状态
        scriptState,

        // 核心
        loadScript,
        validateScript,
        resetExecution,
        stepForward,
        runSteps,
        abort,

        // 辅助
        resetAll,
        getState,
        getBuiltinScripts,
        handleGCPopup,

        // 导入导出
        loadFromFile,
        exportScript,

        // UI更新（外部调用）
        updateUI
    };

})();
