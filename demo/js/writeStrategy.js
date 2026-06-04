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
 * 写入单个LBA页
 * 这是写入的基本单元操作，每次调用都会完整执行：
 * 1. 检查并处理覆写（LPA已映射则将旧页标记为invalid）
 * 2. 分配物理页
 * 3. 更新映射表
 * 4. 检查是否需要触发GC
 * 5. 更新写入计数器
 * 6. 渲染和状态更新
 * @param {number} lpa - 要写入的LPA（逻辑页地址）
 * @param {boolean} renderAfter - 是否在写入后立即渲染（批量写入时可设为false，最后统一渲染）
 * @returns {object|null} 写入的页信息，失败返回null
 */
function writeSingleLba(lpa, renderAfter = true) {
    const { ssdState, state, utils, gc } = window.SSDSimulator;

    // 检查当前PSB是否有空闲页
    const currentPsbFreePages = state.getSuperBlockPages(ssdState.currentPsb)
        .filter(p => p.state === 'empty').length;

    if (currentPsbFreePages === 0) {
        return null; // 当前PSB无空闲页
    }

    // 检查LPA是否已映射，如果已映射则将旧页标记为invalid
    if (ssdState.lpaToPpa.has(lpa)) {
        // 旧LBA覆写：先将旧页标记为invalid
        const oldPpa = ssdState.lpaToPpa.get(lpa);
        const oldPage = ssdState.pages.find(p => p.ppa === oldPpa);
        if (oldPage) {
            oldPage.state = 'invalid';
            ssdState.ppaToLpa.set(oldPpa, lpa);
        }
    }

    // 从当前psb获取第一个空闲页（按page 0-8 → die 0-3顺序）
    let targetPage = state.getFirstFreePageInPsb(ssdState.currentPsb);

    if (!targetPage) {
        // 当前PSB没有空闲页（理论上不应该发生）
        return null;
    }

    // 写入数据
    targetPage.state = 'valid';
    targetPage.lpa = lpa;
    ssdState.lpaToPpa.set(lpa, targetPage.ppa);

    // 更新被写入物理block（SB + Die组合）的写入计数器（用于计算write age）
    state.updateBlockWriteCounter(targetPage.sb, targetPage.die);

    // 检查是否需要触发GC
    const freePagesCount = state.getFreePagesCount();
    if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
        gc.triggerGCPrompt();
    }

    // 检查写入后当前PSB是否已满，如果满了则跳转
    const newFreePages = state.getSuperBlockPages(ssdState.currentPsb)
        .filter(p => p.state === 'empty').length;
    if (newFreePages === 0) {
        const bestPsb = state.selectBestPsb();
        if (bestPsb !== -1 && bestPsb !== ssdState.currentPsb) {
            ssdState.currentPsb = bestPsb;
        }
    }

    // 更新用户写入LBA页计数
    ssdState.userWriteCount++;

    // 根据参数决定是否立即渲染
    if (renderAfter) {
        state.saveState();
        window.SSDSimulator.renderer.renderSSD();
        utils.updateStatus();
        window.SSDSimulator.renderer.updateMappingTable();
        window.SSDSimulator.renderer.updateBlockStatsPanel();
    }

    return {
        lpa: lpa,
        ppa: targetPage.ppa,
        die: targetPage.die,
        sb: targetPage.sb
    };
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
 *
 * 实现：将N次写入等效为连续执行N次writeSingleLba操作
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

    let totalWritten = 0;
    let lpaStart = ssdState.sequentialLpa;
    const pagesToWrite = [];
    let currentLpa = lpaStart;

    // 顺序写：LBA范围1-userPages，超过userPages回到1
    while (totalWritten < actualWriteCount) {
        // LBA超过userPages时回到1
        if (currentLpa > CONFIG.userPages) {
            currentLpa = 1;
        }

        // 连续执行N次写入单个LBA的操作
        const writeResult = writeSingleLba(currentLpa, false); // 最后统一渲染

        if (writeResult === null) {
            // 写入失败（如无空闲页）
            utils.addLog(`顺序写入中断: SB${ssdState.currentPsb}已满`, 'write');
            break;
        }

        pagesToWrite.push(writeResult);
        totalWritten++;
        currentLpa++;

        // 检查空白页数量是否低于GC阈值
        const freePagesCount = state.getFreePagesCount();
        if (freePagesCount <= CONFIG.gcFreePagesThreshold && state.getInvalidPagesCount() > 0) {
            gc.triggerGCPrompt();
        }
    }

    ssdState.sequentialLpa = currentLpa > CONFIG.userPages ? 1 : currentLpa;

    // 写入完成后统一保存状态和渲染
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
 *
 * 实现：将N次写入等效为连续执行N次writeSingleLba操作
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

    const pagesToWrite = [];

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

    let overwriteCount = 0; // 统计覆写次数

    // 连续执行N次写入单个LBA的操作
    for (let i = 0; i < lpaList.length; i++) {
        const lpa = lpaList[i];

        // 记录覆写次数（通过检查写入前是否有映射）
        if (ssdState.lpaToPpa.has(lpa)) {
            overwriteCount++;
        }

        // 执行单个LBA写入
        const writeResult = writeSingleLba(lpa, false); // 最后统一渲染

        if (writeResult === null) {
            // 写入失败（如无空闲页）
            utils.addLog(`随机写入中断: SB${ssdState.currentPsb}已满`, 'write');
            break;
        }

        pagesToWrite.push(writeResult);
    }

    utils.addLog(`随机写入 ${pagesToWrite.length} 页${overwriteCount > 0 ? ` (覆写${overwriteCount}个)` : ''}: LBA随机`, 'write');

    // 写入完成后统一保存状态和渲染
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
    randomWrite,
    writeSingleLba
};