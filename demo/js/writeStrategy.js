/**
 * 写入策略模块
 * 负责SSD的顺序写入和随机写入逻辑
 */

/**
 * 顺序写入
 * 写入策略：
 * 1. 初始状态psb指针指向第一个物理super block（SB0）
 * 2. 按LBA递增顺序写入（LBA范围1-userPages），超过userPages回到1从头开始
 * 3. 如果LBA已映射，先将旧页标记为invalid，再写入新页
 * 4. 按物理顺序写入：SB0 Die0 Page0 → Die1 Page0 → Die2 Page0 → Die3 Page0 → Die0 Page1 → ...
 * 5. 当前psb写满后跳转，指向空页最多的psb（包含OP空间）
 * 6. 如果存在多个空页最大且数目相同的psb，则按照序号跳转（优先级：psb0>psb1>psb2...）
 */
function sequentialWrite(count) {
    const { ssdState, state, utils, gc } = window.SSDSimulator;

    // 检查空白页数量是否低于GC阈值
    const checkAndTriggerGC = () => {
        const freePagesCount = state.getFreePagesCount();
        if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
            gc.triggerGCPrompt();
        }
    };

    let totalWritten = 0;
    let lpaStart = ssdState.sequentialLpa;
    const pagesToWrite = [];

    // 顺序写：LBA范围1-userPages，超过userPages回到1
    let currentLpa = lpaStart;
    let lpasChecked = 0; // 记录已检查的LBA数量，防止无限循环

    while (totalWritten < count) {
        // LBA超过userPages时回到1
        if (currentLpa > CONFIG.userPages) {
            currentLpa = 1;
        }

        // 检查LPA是否已映射，如果已映射则将旧页标记为invalid
        if (ssdState.lpaToPpa.has(currentLpa)) {
            // 旧LBA覆写：先将旧页标记为invalid
            const oldPpa = ssdState.lpaToPpa.get(currentLpa);
            const oldPage = ssdState.pages.find(p => p.ppa === oldPpa);
            if (oldPage) {
                oldPage.state = 'invalid';
                ssdState.ppaToLpa.set(oldPpa, currentLpa);
            }
        }

        // 检查当前psb是否已写满，如果已满则跳转到空页最多的psb
        if (state.isPsbFull(ssdState.currentPsb)) {
            const bestPsb = state.selectBestPsb();
            if (bestPsb === -1) {
                utils.addLog('写入失败: 可用空间不足!', 'gc');
                break;
            }
            if (bestPsb !== ssdState.currentPsb) {
                utils.addLog(`PSB跳转: SB${ssdState.currentPsb}已满 → SB${bestPsb}`, 'write');
                ssdState.currentPsb = bestPsb;
            }
        }

        // 从当前psb获取第一个空闲页（按page 0-8 → die 0-3顺序）
        let targetPage = state.getFirstFreePageInPsb(ssdState.currentPsb);

        if (!targetPage) {
            // 没有空闲页，尝试触发GC
            const freePagesCount = state.getFreePagesCount();
            if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
                gc.triggerGCPrompt();
            }
            utils.addLog(`写入失败: 找不到目标页 LPA ${currentLpa}`, 'gc');
            currentLpa++;
            lpasChecked++;
            if (lpasChecked >= CONFIG.userPages) {
                utils.addLog('顺序写入: 所有LBA已检查，无法写入', 'gc');
                break;
            }
            continue;
        }

        // 写入数据
        targetPage.state = 'valid';
        targetPage.lpa = currentLpa;
        ssdState.lpaToPpa.set(currentLpa, targetPage.ppa);

        pagesToWrite.push({lpa: currentLpa, ppa: targetPage.ppa, die: targetPage.die, sb: targetPage.sb});
        totalWritten++;
        currentLpa++;
        lpasChecked = 0; // 重置计数器

        // 检查是否需要触发GC
        checkAndTriggerGC();
    }

    ssdState.sequentialLpa = currentLpa > CONFIG.userPages ? 1 : currentLpa;

    state.saveState();
    window.SSDSimulator.renderer.renderSSD();
    utils.updateStatus();
    window.SSDSimulator.renderer.updateMappingTable();

    utils.addLog(`顺序写入 ${totalWritten} 页: LPA ${lpaStart}→${lpaStart + totalWritten - 1}`, 'write');
    utils.highlightPages(pagesToWrite.map(p => p.ppa));
}

/**
 * 随机写入
 * LBA是随机的，但物理存储顺序与顺序写相同
 * 写入策略：
 * 1. 初始状态psb指针指向第一个物理super block（SB0）
 * 2. 按物理顺序写入：SB0 Die0 Page0 → Die1 Page0 → Die2 Page0 → Die3 Page0 → Die0 Page1 → ...
 * 3. 当前psb写满后跳转，指向空页最多的psb（包含OP空间）
 * 4. 如果存在多个空页最大且数目相同的psb，则按照序号跳转（优先级：psb0>psb1>psb2...）
 */
function randomWrite(count) {
    const { ssdState, state, utils, gc } = window.SSDSimulator;

    // 检查空白页数量是否低于GC阈值
    const checkAndTriggerGC = () => {
        const freePagesCount = state.getFreePagesCount();
        if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
            gc.triggerGCPrompt();
        }
    };

    const pagesToWrite = [];
    let overwriteCount = 0; // 统计覆写次数

    // 生成随机LPA列表（允许重复，实现覆写场景）
    const lpaList = [];
    for (let i = 0; i < count; i++) {
        const lpa = Math.floor(Math.random() * CONFIG.userPages) + 1;
        lpaList.push(lpa);
    }

    if (lpaList.length === 0) {
        utils.addLog('随机写入失败: 无有效LPA', 'gc');
        return;
    }

    // 预处理：Invalidate所有待写LPA的旧映射（处理覆写场景）
    const uniqueLpas = new Set(lpaList);
    for (const lpa of uniqueLpas) {
        if (ssdState.lpaToPpa.has(lpa)) {
            const oldPpa = ssdState.lpaToPpa.get(lpa);
            const oldPage = ssdState.pages.find(p => p.ppa === oldPpa);
            if (oldPage) {
                oldPage.state = 'invalid';
                ssdState.ppaToLpa.set(oldPpa, lpa);
                overwriteCount++;
            }
        }
    }

    // 按物理顺序写入：每个SB按 Die0 Page0 → Die1 Page0 → Die2 Page0 → Die3 Page0 → Die0 Page1 → ...
    // 当当前SB写满后，跳转到空页最多的SB（包含OP空间）
    for (let i = 0; i < lpaList.length; i++) {
        const lpa = lpaList[i];

        // 检查当前psb是否已写满，如果已满则跳转到空页最多的psb
        if (state.isPsbFull(ssdState.currentPsb)) {
            const bestPsb = state.selectBestPsb();
            if (bestPsb === -1) {
                utils.addLog('写入失败: 可用空间不足!', 'gc');
                break;
            }
            if (bestPsb !== ssdState.currentPsb) {
                utils.addLog(`PSB跳转: SB${ssdState.currentPsb}已满 → SB${bestPsb}`, 'write');
                ssdState.currentPsb = bestPsb;
            }
        }

        // 从当前psb获取第一个空闲页（按page 0-8 → die 0-3顺序）
        let targetPage = state.getFirstFreePageInPsb(ssdState.currentPsb);

        if (!targetPage) {
            utils.addLog(`写入失败: 找不到目标页 LPA ${lpa}`, 'gc');
            continue;
        }

        // 写入数据
        targetPage.state = 'valid';
        targetPage.lpa = lpa;
        ssdState.lpaToPpa.set(lpa, targetPage.ppa);

        pagesToWrite.push({lpa, ppa: targetPage.ppa, die: targetPage.die, sb: targetPage.sb});

        // 检查是否需要触发GC
        checkAndTriggerGC();
    }

    utils.addLog(`随机写入 ${pagesToWrite.length} 页${overwriteCount > 0 ? ` (覆写${overwriteCount}个)` : ''}: LBA随机${overwriteCount > 0 ? ', 旧页已invalidate' : ''}`, 'write');

    state.saveState();
    window.SSDSimulator.renderer.renderSSD();
    utils.updateStatus();
    window.SSDSimulator.renderer.updateMappingTable();

    utils.highlightPages(pagesToWrite.map(p => p.ppa));
}

// 导出模块
window.SSDWriteStrategy = {
    sequentialWrite,
    randomWrite
};