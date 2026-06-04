/**
 * 写入策略模块
 * 负责SSD的顺序写入和随机写入逻辑
 */

/**
 * 检查是否有可用写入空间
 * @returns {object} {hasSpace: boolean, reason: string}
 */
function checkAvailableSpace() {
    const { state } = window.SSDSimulator;
    const freePages = state.getFreePagesCount();
    const invalidPages = state.getInvalidPagesCount();
    const bestPsb = state.selectBestPsb();

    if (bestPsb === -1) {
        // 所有SB都满了，没有空页
        if (invalidPages > 0) {
            return {
                hasSpace: false,
                reason: `物理盘存满！无空闲页(${freePages})，存在${invalidPages}个无效页待GC回收`
            };
        } else {
            return {
                hasSpace: false,
                reason: `物理盘完全存满！无可用空间，无效页为0`
            };
        }
    }
    return { hasSpace: true, reason: '' };
}

/**
 * 顺序写入
 * 写入策略：
 * 1. 初始状态psb指针指向第一个物理super block（SB0）
 * 2. 按LBA递增顺序写入（LBA范围1-userPages），超过userPages回到1从头开始
 * 3. 如果LBA已映射，先将旧页标记为invalid，再写入新页
 * 4. 按物理顺序写入：SB0 Die0 Page0 → Die1 Page0 → Die2 Page0 → Die3 Page0 → Die0 Page1 → ...
 * 5. 写入数量限制为当前PSB的空页数量
 * 6. 如果请求数量 > 当前PSB空页数，写入完成后跳转到空页最多的PSB
 * 7. 跳转规则：空页最多的PSB，相同则按序号（优先级：SB0 > SB1 > SB2...）
 */
function sequentialWrite(count) {
    const { ssdState, state, utils, gc } = window.SSDSimulator;

    // 检查当前PSB的剩余空页数量
    const currentPsbFreePages = state.getSuperBlockPages(ssdState.currentPsb)
        .filter(p => p.state === 'empty').length;

    // 写入数量限制为当前PSB的空页数量
    const actualWriteCount = Math.min(count, currentPsbFreePages);
    if (actualWriteCount === 0) {
        utils.addLog(`顺序写入失败: SB${ssdState.currentPsb}无空闲页，请先执行GC`, 'gc');
        gc.triggerGCPrompt();
        return;
    }

    // 记录是否需要跳转PSB（请求数量超过当前PSB空页数，或写入后PSB被写满）
    const psbWillBeFull = actualWriteCount === currentPsbFreePages;
    if (count > currentPsbFreePages) {
        utils.addLog(`顺序写入: SB${ssdState.currentPsb}仅剩${currentPsbFreePages}个空页，限制写入${actualWriteCount}页后跳转`, 'write');
    } else if (psbWillBeFull) {
        utils.addLog(`顺序写入: SB${ssdState.currentPsb}写入${actualWriteCount}页后PSB写满，切换PSB`, 'write');
    }

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

    while (totalWritten < actualWriteCount) {
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

        // 从当前psb获取第一个空闲页（按page 0-8 → die 0-3顺序）
        let targetPage = state.getFirstFreePageInPsb(ssdState.currentPsb);

        if (!targetPage) {
            // 当前PSB没有空闲页（理论上不应该发生，因为已限制写入数量）
            utils.addLog(`顺序写入中断: SB${ssdState.currentPsb}已满`, 'write');
            break;
        }

        // 写入数据
        targetPage.state = 'valid';
        targetPage.lpa = currentLpa;
        ssdState.lpaToPpa.set(currentLpa, targetPage.ppa);

        pagesToWrite.push({lpa: currentLpa, ppa: targetPage.ppa, die: targetPage.die, sb: targetPage.sb});
        totalWritten++;
        currentLpa++;

        // 检查是否需要触发GC
        checkAndTriggerGC();
    }

    ssdState.sequentialLpa = currentLpa > CONFIG.userPages ? 1 : currentLpa;

    // 如果写入后PSB被写满，跳转到空页最多的PSB
    if (psbWillBeFull) {
        const bestPsb = state.selectBestPsb();
        if (bestPsb !== -1 && bestPsb !== ssdState.currentPsb) {
            utils.addLog(`PSB跳转: SB${ssdState.currentPsb}已满 → SB${bestPsb}(空页最多)`, 'write');
            ssdState.currentPsb = bestPsb;
        }
    }

    // 更新用户写入LBA页计数
    if (totalWritten > 0) {
        ssdState.userWriteCount += totalWritten;
    }

    // 更新被写入物理block（SB + Die组合）的写入计数器（用于计算write age）
    // 只有写入valid页才算写入动作
    const writtenBlocks = new Set(pagesToWrite.map(p => `${p.sb}_${p.die}`));
    writtenBlocks.forEach(blockKey => {
        const [sb, die] = blockKey.split('_').map(Number);
        state.updateBlockWriteCounter(sb, die);
    });

    state.saveState();
    window.SSDSimulator.renderer.renderSSD();
    utils.updateStatus();
    window.SSDSimulator.renderer.updateMappingTable();
    window.SSDSimulator.renderer.updateBlockStatsPanel();

    utils.addLog(`顺序写入 ${totalWritten} 页: LPA ${lpaStart}→${lpaStart + totalWritten - 1}`, 'write');
    utils.highlightPages(pagesToWrite.map(p => p.ppa));
}

/**
 * 随机写入
 * LBA是随机的，但物理存储顺序与顺序写相同
 * 写入策略：
 * 1. 初始状态psb指针指向第一个物理super block（SB0）
 * 2. 按物理顺序写入：SB0 Die0 Page0 → Die1 Page0 → Die2 Page0 → Die3 Page0 → Die0 Page1 → ...
 * 3. 写入数量限制为当前PSB的空页数量
 * 4. 如果请求数量 > 当前PSB空页数，写入完成后跳转到空页最多的PSB
 * 5. 跳转规则：空页最多的PSB，相同则按序号（优先级：SB0 > SB1 > SB2...）
 */
function randomWrite(count) {
    const { ssdState, state, utils, gc } = window.SSDSimulator;

    // 检查当前PSB的剩余空页数量
    const currentPsbFreePages = state.getSuperBlockPages(ssdState.currentPsb)
        .filter(p => p.state === 'empty').length;

    // 写入数量限制为当前PSB的空页数量
    const actualWriteCount = Math.min(count, currentPsbFreePages);
    if (actualWriteCount === 0) {
        utils.addLog(`随机写入失败: SB${ssdState.currentPsb}无空闲页，请先执行GC`, 'gc');
        gc.triggerGCPrompt();
        return;
    }

    // 记录是否需要跳转PSB（请求数量超过当前PSB空页数，或写入后PSB被写满）
    const psbWillBeFull = actualWriteCount === currentPsbFreePages;
    if (count > currentPsbFreePages) {
        utils.addLog(`随机写入: SB${ssdState.currentPsb}仅剩${currentPsbFreePages}个空页，限制写入${actualWriteCount}页后跳转`, 'write');
    } else if (psbWillBeFull) {
        utils.addLog(`随机写入: SB${ssdState.currentPsb}写入${actualWriteCount}页后PSB写满，切换PSB`, 'write');
    }

    // 检查空白页数量是否低于GC阈值
    const checkAndTriggerGC = () => {
        const freePagesCount = state.getFreePagesCount();
        if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
            gc.triggerGCPrompt();
        }
    };

    const pagesToWrite = [];
    let overwriteCount = 0; // 统计覆写次数

    // 生成随机LPA列表（只生成实际要写入的数量，允许重复，实现覆写场景）
    const lpaList = [];
    for (let i = 0; i < actualWriteCount; i++) {
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

    // 限制写入数量为当前PSB的空页数量
    let writtenCount = 0;
    for (let i = 0; i < lpaList.length && writtenCount < actualWriteCount; i++) {
        const lpa = lpaList[i];

        // 从当前psb获取第一个空闲页（按page 0-8 → die 0-3顺序）
        let targetPage = state.getFirstFreePageInPsb(ssdState.currentPsb);

        if (!targetPage) {
            // 当前PSB没有空闲页（理论上不应该发生，因为已限制写入数量）
            utils.addLog(`随机写入中断: SB${ssdState.currentPsb}已满`, 'write');
            break;
        }

        // 写入数据
        targetPage.state = 'valid';
        targetPage.lpa = lpa;
        ssdState.lpaToPpa.set(lpa, targetPage.ppa);

        pagesToWrite.push({lpa, ppa: targetPage.ppa, die: targetPage.die, sb: targetPage.sb});
        writtenCount++;

        // 检查是否需要触发GC
        checkAndTriggerGC();
    }

    utils.addLog(`随机写入 ${pagesToWrite.length} 页${overwriteCount > 0 ? ` (覆写${overwriteCount}个)` : ''}: LBA随机${overwriteCount > 0 ? ', 旧页已invalidate' : ''}`, 'write');

    // 如果写入后PSB被写满，跳转到空页最多的PSB
    if (psbWillBeFull) {
        const bestPsb = state.selectBestPsb();
        if (bestPsb !== -1 && bestPsb !== ssdState.currentPsb) {
            utils.addLog(`PSB跳转: SB${ssdState.currentPsb}已满 → SB${bestPsb}(空页最多)`, 'write');
            ssdState.currentPsb = bestPsb;
        }
    }

    // 更新用户写入LBA页计数
    if (pagesToWrite.length > 0) {
        ssdState.userWriteCount += pagesToWrite.length;
    }

    // 更新被写入物理block（SB + Die组合）的写入计数器（用于计算write age）
    // 只有写入valid页才算写入动作
    const writtenBlocks = new Set(pagesToWrite.map(p => `${p.sb}_${p.die}`));
    writtenBlocks.forEach(blockKey => {
        const [sb, die] = blockKey.split('_').map(Number);
        state.updateBlockWriteCounter(sb, die);
    });

    state.saveState();
    window.SSDSimulator.renderer.renderSSD();
    utils.updateStatus();
    window.SSDSimulator.renderer.updateMappingTable();
    window.SSDSimulator.renderer.updateBlockStatsPanel();

    utils.highlightPages(pagesToWrite.map(p => p.ppa));
}

// 导出模块
window.SSDWriteStrategy = {
    sequentialWrite,
    randomWrite
};