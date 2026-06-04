/**
 * GC策略模块
 * 负责垃圾回收的victim选择、执行流程和步进式演示
 */

let gcStepCallback = null;

// 拖动状态
let dragState = {
    isDragging: false,
    currentHandle: null,
    currentModal: null,
    offsetX: 0,
    offsetY: 0
};

/**
 * 初始化弹窗拖动功能
 */
function initModalDrag() {
    // GC触发弹窗拖动
    const gcTriggerHandle = document.getElementById('gcTriggerDragHandle');
    const gcTriggerModal = document.getElementById('gcTriggerModal');
    if (gcTriggerHandle && gcTriggerModal) {
        makeDraggable(gcTriggerHandle, gcTriggerModal);
    }

    // GC步骤弹窗拖动
    const gcStepHandle = document.getElementById('gcStepDragHandle');
    const gcStepModal = document.getElementById('gcStepModal');
    if (gcStepHandle && gcStepModal) {
        makeDraggable(gcStepHandle, gcStepModal);
    }
}

/**
 * 使元素可拖动
 * @param {HTMLElement} handle - 拖动手柄元素
 * @param {HTMLElement} modal - 要移动的弹窗元素
 */
function makeDraggable(handle, modal) {
    // 鼠标按下开始拖动
    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        dragState.isDragging = true;
        dragState.currentHandle = handle;
        dragState.currentModal = modal;

        // 计算鼠标相对于弹窗的偏移
        const rect = modal.getBoundingClientRect();
        dragState.offsetX = e.clientX - rect.left;
        dragState.offsetY = e.clientY - rect.top;

        // 添加拖动中的视觉反馈
        modal.style.opacity = '0.95';
        modal.style.transform = 'scale(1.02)';
    });

    // 鼠标移动
    document.addEventListener('mousemove', function(e) {
        if (!dragState.isDragging || !dragState.currentModal) return;

        const overlay = dragState.currentModal.parentElement;
        const overlayRect = overlay.getBoundingClientRect();

        // 计算新的位置（相对于overlay）
        let newX = e.clientX - overlayRect.left - dragState.offsetX;
        let newY = e.clientY - overlayRect.top - dragState.offsetY;

        // 限制在overlay范围内
        const modalRect = dragState.currentModal.getBoundingClientRect();
        newX = Math.max(0, Math.min(newX, overlayRect.width - modalRect.width));
        newY = Math.max(0, Math.min(newY, overlayRect.height - modalRect.height));

        // 应用位置
        dragState.currentModal.style.position = 'absolute';
        dragState.currentModal.style.left = newX + 'px';
        dragState.currentModal.style.top = newY + 'px';
        dragState.currentModal.style.right = 'auto';
        dragState.currentModal.style.bottom = 'auto';
    });

    // 鼠标释放结束拖动
    document.addEventListener('mouseup', function() {
        if (dragState.isDragging && dragState.currentModal) {
            // 移除视觉反馈
            dragState.currentModal.style.opacity = '';
            dragState.currentModal.style.transform = '';
        }
        dragState.isDragging = false;
        dragState.currentHandle = null;
        dragState.currentModal = null;
    });
}

/**
 * 重置弹窗位置到居中
 * @param {HTMLElement} modal - 弹窗元素
 */
function resetModalPosition(modal) {
    modal.style.position = '';
    modal.style.left = '';
    modal.style.top = '';
    modal.style.right = '';
    modal.style.bottom = '';
    modal.style.opacity = '';
    modal.style.transform = '';
}

// 页面加载完成后初始化拖动
document.addEventListener('DOMContentLoaded', function() {
    // 延迟初始化确保DOM已完全加载
    setTimeout(initModalDrag, 100);
});

/**
 * 选择GC victim SB（无效页最多的SB）
 */
function selectVictimPsb() {
    const psbCounts = window.SSDSimulator.utils.getPsbInvalidCounts();
    // 返回无效页数量最多的SB
    return psbCounts.find(p => p.invalidCount > 0);
}

/**
 * 手动触发GC
 */
function triggerGC() {
    const invalidPages = window.SSDSimulator.state.getInvalidPages();
    if (invalidPages.length === 0) {
        window.SSDSimulator.utils.addLog('GC: 无效页为空，无需回收', 'gc');
        return;
    }

    performGC();
}

/**
 * GC触发弹窗提示
 */
function triggerGCPrompt() {
    const { ssdState, state, utils } = window.SSDSimulator;

    // 检查是否已经有弹窗显示，避免重复弹出
    const gcOverlay = document.getElementById('gcTriggerOverlay');
    if (gcOverlay && gcOverlay.classList.contains('active')) {
        return;
    }

    const freePagesCount = state.getFreePagesCount();
    const invalidPagesCount = state.getInvalidPagesCount();

    // 确保满足GC触发条件：空白页数量 <= 阈值 且 有无效页可回收
    if (freePagesCount > CONFIG.gcFreePagesThreshold || invalidPagesCount === 0) {
        return;
    }

    // 获取各PSB无效页统计
    const psbCounts = utils.getPsbInvalidCounts();
    let sbStats = '';
    psbCounts.forEach(p => {
        if (p.invalidCount > 0) {
            sbStats += `SB${p.sb}${p.isOp ? '(OP)' : ''}: ${p.invalidCount}个无效页\n`;
        }
    });

    // 获取将选中的victim SB
    const victimSB = selectVictimPsb();
    const victimIsOp = victimSB ? victimSB.sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks : false;

    // 显示弹窗
    gcOverlay.classList.add('active');

    // 更新弹窗内容
    document.getElementById('gcTriggerTitle').textContent = 'GC 触发提示';
    document.getElementById('gcTriggerDesc').innerHTML = `
        <div style="text-align: left; line-height: 1.8;">
            <div style="color: #ffc107; font-weight: bold; margin-bottom: 10px;">⚠️ SSD需要执行垃圾回收(GC)</div>
            <div><strong>触发条件:</strong> 空白页数量(${freePagesCount}) ≤ 阈值(${CONFIG.gcFreePagesThreshold})</div>
            <div><strong>无效页数量:</strong> ${invalidPagesCount} 个</div>
            <br>
            <div><strong>各PSB无效页统计:</strong></div>
            <div style="font-family: 'JetBrains Mono'; font-size: 12px; color: #aaa; padding-left: 10px; white-space: pre-line;">${sbStats || '无'}</div>
            <br>
            <div><strong>GC将选择:</strong> SB${victimSB ? victimSB.sb : 'N/A'}${victimIsOp ? '(OP)' : ''} (无效页最多的SB)</div>
            <br>
            <div style="color: #4ecca3;">GC执行: 读取有效页 → 擦除 → 写回</div>
        </div>
    `;

    // 保存victim信息用于确认后执行
    window.pendingGCVictim = victimSB;
}

/**
 * GC触发弹窗确认执行
 */
function gcTriggerConfirm() {
    const modal = document.getElementById('gcTriggerModal');
    resetModalPosition(modal);
    document.getElementById('gcTriggerOverlay').classList.remove('active');

    if (window.pendingGCVictim) {
        window.SSDSimulator.utils.addLog(`GC触发: 空白页${window.SSDSimulator.state.getFreePagesCount()} <= 阈值${CONFIG.gcFreePagesThreshold}`, 'gc');
        showGCSteps(window.pendingGCVictim);
        window.pendingGCVictim = null;
    }

    window.SSDSimulator.utils.updateStatus();
}

/**
 * GC触发弹窗取消
 */
function gcTriggerCancel() {
    const modal = document.getElementById('gcTriggerModal');
    resetModalPosition(modal);
    document.getElementById('gcTriggerOverlay').classList.remove('active');
    window.pendingGCVictim = null;
    window.SSDSimulator.utils.addLog('GC: 用户取消GC触发', 'gc');
}

/**
 * 执行GC（带弹窗步进显示）
 */
function performGC() {
    const { ssdState, state, utils } = window.SSDSimulator;

    // 使用"无效页最多"策略选择victim SB（包含OP空间）
    const victimSB = selectVictimPsb();

    if (!victimSB || victimSB.invalidCount === 0) {
        utils.addLog('GC: 无需回收，所有块均无可回收空间', 'gc');
        return;
    }

    // 显示GC各PSB的无效页统计信息
    const psbCounts = utils.getPsbInvalidCounts();
    let statsInfo = '各PSB无效页统计(含OP): ';
    psbCounts.forEach(p => {
        statsInfo += `SB${p.sb}${p.isOp ? '(OP)' : ''}:${p.invalidCount} `;
    });
    const victimIsOp = victimSB.sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;
    utils.addLog(`GC: 选择SB${victimSB.sb}${victimIsOp ? '(OP)' : ''}(无效最多) → ${statsInfo}`, 'gc');

    // Show GC step-by-step
    showGCSteps(victimSB);
}

/**
 * 显示GC步骤（4步GC流程弹窗）
 */
function showGCSteps(victimSB) {
    const { ssdState, state, utils } = window.SSDSimulator;

    const victimPages = state.getSuperBlockPages(victimSB.sb);
    const validPages = victimPages.filter(p => p.state === 'valid');
    const invalidPages = victimPages.filter(p => p.state === 'invalid');

    // 按读取顺序组织有效页: Die0 Page0 -> Die1 Page0 -> Die2 Page0 -> Die3 Page0 -> Die0 Page1 -> ...
    const ramData = [];
    for (let page = 0; page < CONFIG.pagesPerBlock; page++) {
        for (let die = 0; die < CONFIG.dieCount; die++) {
            const pageData = validPages.find(p => p.page === page && p.die === die);
            if (pageData) {
                ramData.push({lpa: pageData.lpa, die: pageData.die, page: pageData.page});
            }
        }
    }

    let currentStep = 1;
    const totalSteps = 4;

    document.getElementById('gcOverlay').classList.add('active');

    // 显示各PSB无效页统计（区分用户空间和OP空间）
    const psbCounts = utils.getPsbInvalidCounts();
    let psbStatsDesc = '各PSB无效页统计 (含OP空间):\n';
    psbCounts.forEach(p => {
        psbStatsDesc += `  SB${p.sb}${p.isOp ? '(OP)' : ''}: ${p.invalidCount}个无效页`;
        if (p.sb === victimSB.sb) psbStatsDesc += ' ← 选择';
        psbStatsDesc += '\n';
    });

    function updateStepUI(step, title, desc) {
        document.getElementById('gcStepTitle').textContent = title;
        document.getElementById('gcStepDesc').textContent = desc;

        for (let i = 1; i <= 4; i++) {
            const dot = document.getElementById('dot' + i);
            if (dot) {
                dot.className = 'gc-step-dot';
                if (i < step) dot.classList.add('completed');
                else if (i === step) dot.classList.add('active');
            }
        }
    }

    // Step 1: 选择victim SB
    const victimIsOp = victimSB.sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;
    updateStepUI(1, '选择 Victim Super Block',
        `已选择 Super Block ${victimSB.sb}${victimIsOp ? ' (OP空间)' : ''} 作为GC目标\n\n` +
        `SB${victimSB.sb} 状态:\n` +
        `  - 无效页: ${victimSB.invalidCount} 个\n` +
        `  - 有效页: ${victimSB.validCount} 个\n` +
        `  - 空页: ${victimSB.emptyCount} 个\n\n` +
        psbStatsDesc +
        `\nGC策略: 选择无效页最多的SB（OP空间参与选择）`);

    // 存储victim信息
    window.gcVictimSB = victimSB;
    window.gcVictimPages = victimPages;
    window.gcRamData = ramData;
    window.gcCurrentRamIndex = 0;

    window.gcStepNext = function() {
        currentStep++;

        if (currentStep === 2) {
            // Step 2: 读取有效页到RAM（按指定顺序）
            updateStepUI(2, '① 读取有效页到RAM',
                `正在读取SB${victimSB.sb}的有效页到RAM...\n\n` +
                `读取顺序:\n` +
                `  SB${victimSB.sb} Die0 Page0 → Die1 Page0 → Die2 Page0 → Die3 Page0\n` +
                `  SB${victimSB.sb} Die0 Page1 → Die1 Page1 → Die2 Page1 → Die3 Page1\n` +
                `  ... (无效页跳过)\n\n` +
                `有效页列表:\n` +
                ramData.slice(0, 5).map(d => `  SB${victimSB.sb} Die${d.die} Page${d.page} → LPA${d.lpa}`).join('\n') +
                (ramData.length > 5 ? `\n  ... 共 ${ramData.length} 个有效页` : ''));

            // 将victim SB的有效页标记为"已读取"状态
            validPages.forEach(page => {
                page.state = 'readToRam';
            });

            window.SSDSimulator.renderer.renderSSD();

        } else if (currentStep === 3) {
            // Step 3: 清空GC目标psb
            updateStepUI(3, '② 清空GC目标PSB',
                `正在清空 Super Block ${victimSB.sb}...\n\n` +
                `操作:\n` +
                `  - 擦除所有 ${victimSB.total} 个页\n` +
                `  - ${victimSB.invalidCount} 个无效页被释放\n` +
                `  - ${victimSB.validCount} 个有效页数据暂存于RAM\n\n` +
                `清理映射表:\n` +
                `  - 移除 ${victimSB.invalidCount} 个无效LPA映射\n\n` +
                `等待数据写回...`);

            // 清除victim SB所有页
            victimPages.forEach(page => {
                page.state = 'empty';
                page.lpa = null;
            });

            // 从映射表中移除
            invalidPages.forEach(page => {
                if (page.lpa !== null) {
                    ssdState.lpaToPpa.delete(page.lpa);
                }
            });

            // 设置写入psb指针（初始指向victim SB）
            window.gcWriteTargetPsb = victimSB.sb;

            window.SSDSimulator.renderer.renderSSD();

        } else if (currentStep === 4) {
            // Step 4: 按照写入策略将RAM数据写回
            updateStepUI(4, '③ 写入策略写回数据',
                `正在按照写入策略将RAM数据写回...\n\n` +
                `写入策略:\n` +
                `  1. 检查当前PSB是否写满\n` +
                `  2. 跳转到空页最多的PSB\n` +
                `  3. 按page→die顺序写入\n\n` +
                `写回目标: SB${window.gcWriteTargetPsb}\n` +
                `待写回: ${window.gcRamData.length} 个有效页`);

            // 记录GC写回涉及的物理block（SB + Die组合）集合（用于更新write age）
            const gcWrittenBlocks = new Set();

            // 执行写入（按照写入策略）
            window.gcRamData.forEach(data => {
                // 检查当前psb是否写满，需要跳转
                if (state.isPsbFull(ssdState.currentPsb)) {
                    const bestPsb = state.selectBestPsb();
                    if (bestPsb !== -1 && bestPsb !== ssdState.currentPsb) {
                        ssdState.currentPsb = bestPsb;
                    }
                }

                const targetPage = state.getFirstFreePageInPsb(ssdState.currentPsb);
                if (targetPage) {
                    targetPage.state = 'valid';
                    targetPage.lpa = data.lpa;
                    ssdState.lpaToPpa.set(data.lpa, targetPage.ppa);
                    // 按物理block（SB + Die）记录
                    gcWrittenBlocks.add(`${targetPage.sb}_${targetPage.die}`);
                }
            });

            // 记录GC写回的有效页数量（在写回前保存，因为后面会清空）
            const gcWriteBackCount = window.gcRamData ? window.gcRamData.length : 0;

            // 更新GC写回涉及物理block的写入计数器
            gcWrittenBlocks.forEach(blockKey => {
                const [sb, die] = blockKey.split('_').map(Number);
                state.updateBlockWriteCounter(sb, die);
            });

            // 更新GC重新写入有效LBA计数（在写回完成后才计数）
            if (gcWriteBackCount > 0) {
                ssdState.gcWriteCount += gcWriteBackCount;
            }

            window.gcRamData = null;
            window.SSDSimulator.renderer.renderSSD();

        } else if (currentStep > totalSteps) {
            // Complete
            // GC次数只增加一次（整个GC操作完成后才计数）
            ssdState.gcTriggerCount++;

            // GC完成后，更新psb写入指针指向空页最多的psb（包括OP空间）
            const bestPsbAfterGC = state.selectBestPsb();
            if (bestPsbAfterGC !== -1) {
                if (bestPsbAfterGC !== ssdState.currentPsb) {
                    utils.addLog(`PSB指针更新: → SB${bestPsbAfterGC}(空页最多)`, 'gc');
                }
                ssdState.currentPsb = bestPsbAfterGC;
            }

            // 重置弹窗位置并关闭
            const modal = document.getElementById('gcStepModal');
            resetModalPosition(modal);
            document.getElementById('gcOverlay').classList.remove('active');
            state.saveState();
            window.SSDSimulator.renderer.renderSSD();
            utils.updateStatus();
            window.SSDSimulator.renderer.updateMappingTable();
            window.SSDSimulator.renderer.updateBlockStatsPanel();
            utils.addLog(`GC完成: SB${victimSB.sb}回收, 获得${victimSB.invalidCount}个空页`, 'gc');
            return;
        }
    };
}

// 导出模块
window.SSDGCStrategy = {
    gcStepCallback,
    selectVictimPsb,
    triggerGC,
    triggerGCPrompt,
    gcTriggerConfirm,
    gcTriggerCancel,
    performGC,
    showGCSteps
};