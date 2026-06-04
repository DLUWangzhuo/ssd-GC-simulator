/**
 * SSD 状态管理模块
 * 负责管理SSD的状态、页结构、映射表和历史记录
 */

// SSD State
let ssdState = {
    pages: [], // 所有页
    lpaToPpa: new Map(), // LPA -> PPA mapping
    ppaToLpa: new Map(), // PPA -> LPA mapping (for invalidation)
    sequentialLpa: 1, // LBA起始地址从1开始
    history: [],
    historyIndex: -1,
    currentPsb: 0, // PSB指针，初始指向第一个super block
    gcTriggerCount: 0, // GC触发次数
    userWriteCount: 0, // 用户写入LBA页数目
    gcWriteCount: 0, // GC重新写入有效LBA数目
    blockWriteCounter: {}, // 每个物理block最近一次写入时的全局计数器值（用于计算write age），key格式：'sb_die'
    globalWriteCounter: 0 // 全局写入计数器，每次写入valid页时递增
};

/**
 * 初始化SSD状态
 */
function initSSD() {
    ssdState.pages = [];
    ssdState.lpaToPpa.clear();
    ssdState.ppaToLpa.clear();
    ssdState.sequentialLpa = 1; // LBA起始地址从1开始
    ssdState.history = [];
    ssdState.historyIndex = -1;
    ssdState.currentPsb = 0; // PSB指针初始指向第一个super block
    ssdState.gcTriggerCount = 0; // GC触发次数清零
    ssdState.userWriteCount = 0; // 用户写入LBA页数目清零
    ssdState.gcWriteCount = 0; // GC重新写入有效LBA数目清零
    ssdState.blockWriteCounter = {}; // 重置block写入年龄追踪
    ssdState.globalWriteCounter = 0; // 重置全局写入计数器

    // Create pages: 根据配置的SuperBlock数量，每个SB包含4个Die-Block，每个Block包含9页
    for (let sb = 0; sb < CONFIG.totalSuperBlocks; sb++) {
        for (let die = 0; die < CONFIG.dieCount; die++) {
            // 初始化每个物理block（SB + Die组合）的writeCounter为-1（表示从未写入）
            ssdState.blockWriteCounter[`${sb}_${die}`] = -1;

            for (let page = 0; page < CONFIG.pagesPerBlock; page++) {
                const ppa = ssdState.pages.length;
                ssdState.pages.push({
                    ppa,
                    sb,
                    die,
                    block: 0, // Each Die contributes 1 Block to the Super Block
                    page,
                    state: 'empty', // empty, valid, invalid
                    lpa: null
                });
            }
        }
    }

    window.SSDSimulator.state.saveState();

    // 渲染和更新（延迟到模块组装完成后）
    if (window.SSDSimulator && window.SSDSimulator.renderer) {
        window.SSDSimulator.renderer.renderSSD();
        window.SSDSimulator.renderer.updateMappingTable();
        window.SSDSimulator.renderer.updateBlockStatsPanel();
    }
    if (window.SSDSimulator && window.SSDSimulator.utils) {
        window.SSDSimulator.utils.updateStatus();
    }
    if (window.SSDConfig) {
        window.SSDConfig.updateConfigSummary(); // 更新配置摘要显示
    }
}

/**
 * 获取指定SB的所有页
 */
function getSuperBlockPages(sb) {
    return ssdState.pages.filter(p => p.sb === sb);
}

/**
 * 获取所有空闲页
 */
function getFreePages() {
    return ssdState.pages.filter(p => p.state === 'empty');
}

/**
 * 获取所有无效页
 */
function getInvalidPages() {
    return ssdState.pages.filter(p => p.state === 'invalid');
}

/**
 * 获取空闲页数量
 */
function getFreePagesCount() {
    return getFreePages().length;
}

/**
 * 获取已用页数量
 */
function getUsedPagesCount() {
    return ssdState.pages.filter(p => p.state === 'valid').length;
}

/**
 * 获取无效页数量
 */
function getInvalidPagesCount() {
    return getInvalidPages().length;
}

/**
 * 选择最佳PSB（空页最多的psb，如果相同按序号选择）
 * 包含OP空间，所有SB都参与选择
 */
function selectBestPsb() {
    const psbEmptyCounts = [];

    for (let sb = 0; sb < CONFIG.totalSuperBlocks; sb++) {
        const sbPages = getSuperBlockPages(sb);
        const emptyCount = sbPages.filter(p => p.state === 'empty').length;
        if (emptyCount > 0) {
            const isOp = sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;
            psbEmptyCounts.push({sb, emptyCount, isOp});
        }
    }

    if (psbEmptyCounts.length === 0) {
        return -1; // 没有空闲空间
    }

    // 按空页数降序排序，相同时按sb序号升序（优先级：SB0 > SB1 > SB2...）
    psbEmptyCounts.sort((a, b) => {
        if (b.emptyCount !== a.emptyCount) {
            return b.emptyCount - a.emptyCount;
        }
        return a.sb - b.sb; // 序号小的排前面
    });

    return psbEmptyCounts[0].sb;
}

/**
 * 获取指定PSB中可写入的空闲页
 * 按page(0-8) -> die(0-3)的顺序返回第一个可用页
 */
function getFirstFreePageInPsb(sb) {
    const sbPages = getSuperBlockPages(sb).filter(p => p.state === 'empty');
    if (sbPages.length === 0) return null;

    // 按page(0-8) -> die(0-3)排序
    sbPages.sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return a.die - b.die;
    });

    return sbPages[0];
}

/**
 * 检查当前psb是否已写满
 */
function isPsbFull(sb) {
    const sbPages = getSuperBlockPages(sb);
    return sbPages.every(p => p.state !== 'empty');
}

/**
 * 更新物理block的写入计数器（用于计算write age）
 * @param {number} sb - Super Block编号
 * @param {number} die - Die编号
 */
function updateBlockWriteCounter(sb, die) {
    // 全局计数器递增
    ssdState.globalWriteCounter++;
    // 使用全局计数器更新该物理block（SB + Die组合）的写入年龄参考点
    ssdState.blockWriteCounter[`${sb}_${die}`] = ssdState.globalWriteCounter;
}

/**
 * 获取物理block的write age（基于全局写入计数器的差值）
 * @param {number} sb - Super Block编号
 * @param {number} die - Die编号
 * @returns {number} write age（当前全局计数器与该block上次写入计数器的差值）
 */
function getBlockWriteAge(sb, die) {
    const lastWriteCounter = ssdState.blockWriteCounter[`${sb}_${die}`];
    if (lastWriteCounter === undefined || lastWriteCounter === -1) return 0; // 从未写入的block，年龄为0

    // 计算age = 当前全局计数器 - 上次写入时的计数器
    return ssdState.globalWriteCounter - lastWriteCounter;
}

/**
 * 获取指定SB中指定Die的所有页
 */
function getBlockPages(sb, die) {
    return ssdState.pages.filter(p => p.sb === sb && p.die === die);
}

/**
 * 获取所有物理block的统计信息（用于统计面板）
 * 返回数组，每个元素包含：sb, die, validPercent, writeAge, validCount, totalCount, isOp, blockId
 * 按writeAge从大到小排序（左侧=旧，右侧=新）
 */
function getBlockStats() {
    const stats = [];

    for (let sb = 0; sb < CONFIG.totalSuperBlocks; sb++) {
        for (let die = 0; die < CONFIG.dieCount; die++) {
            const blockPages = getBlockPages(sb, die);
            const validCount = blockPages.filter(p => p.state === 'valid').length;
            const invalidCount = blockPages.filter(p => p.state === 'invalid').length;
            const emptyCount = blockPages.filter(p => p.state === 'empty').length;
            const totalCount = blockPages.length;
            const validPercent = (validCount / totalCount) * 100;
            const writeAge = getBlockWriteAge(sb, die);
            const isOp = sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;

            stats.push({
                sb,
                die,
                blockId: `SB${sb} Die${die}`,
                validCount,
                invalidCount,
                emptyCount,
                totalCount,
                validPercent,
                writeAge,
                isOp
            });
        }
    }

    // 按writeAge从大到小排序（左侧=旧block，右侧=新block）
    stats.sort((a, b) => b.writeAge - a.writeAge);

    return stats;
}

/**
 * 保存当前状态用于撤销
 */
function saveState() {
    const stateCopy = {
        pages: ssdState.pages.map(p => ({...p})),
        lpaToPpa: new Map(ssdState.lpaToPpa),
        ppaToLpa: new Map(ssdState.ppaToLpa),
        sequentialLpa: ssdState.sequentialLpa,
        currentPsb: ssdState.currentPsb,
        gcTriggerCount: ssdState.gcTriggerCount,
        userWriteCount: ssdState.userWriteCount,
        gcWriteCount: ssdState.gcWriteCount,
        blockWriteCounter: {...ssdState.blockWriteCounter},
        globalWriteCounter: ssdState.globalWriteCounter
    };

    // Remove future states if we're not at the end
    if (ssdState.historyIndex < ssdState.history.length - 1) {
        ssdState.history = ssdState.history.slice(0, ssdState.historyIndex + 1);
    }

    ssdState.history.push(stateCopy);

    // Limit history size
    if (ssdState.history.length > CONFIG.maxHistory) {
        ssdState.history.shift();
    } else {
        ssdState.historyIndex++;
    }

    window.SSDSimulator.state.updateHistoryButtons();
}

/**
 * 撤销操作
 */
function undo() {
    if (ssdState.historyIndex > 0) {
        ssdState.historyIndex--;
        const state = ssdState.history[ssdState.historyIndex];
        ssdState.pages = state.pages.map(p => ({...p}));
        ssdState.lpaToPpa = new Map(state.lpaToPpa);
        ssdState.ppaToLpa = new Map(state.ppaToLpa);
        ssdState.sequentialLpa = state.sequentialLpa;
        ssdState.currentPsb = state.currentPsb;
        ssdState.gcTriggerCount = state.gcTriggerCount;
        ssdState.userWriteCount = state.userWriteCount;
        ssdState.gcWriteCount = state.gcWriteCount;
        ssdState.blockWriteCounter = {...state.blockWriteCounter};
        ssdState.globalWriteCounter = state.globalWriteCounter;

        window.SSDSimulator.renderer.renderSSD();
        window.SSDSimulator.utils.updateStatus();
        window.SSDSimulator.renderer.updateMappingTable();
        window.SSDSimulator.renderer.updateBlockStatsPanel();
        window.SSDSimulator.utils.addLog('撤销操作', 'write');
        window.SSDSimulator.state.updateHistoryButtons();
    }
}

/**
 * 重做操作
 */
function redo() {
    if (ssdState.historyIndex < ssdState.history.length - 1) {
        ssdState.historyIndex++;
        const state = ssdState.history[ssdState.historyIndex];
        ssdState.pages = state.pages.map(p => ({...p}));
        ssdState.lpaToPpa = new Map(state.lpaToPpa);
        ssdState.ppaToLpa = new Map(state.ppaToLpa);
        ssdState.sequentialLpa = state.sequentialLpa;
        ssdState.currentPsb = state.currentPsb;
        ssdState.gcTriggerCount = state.gcTriggerCount;
        ssdState.userWriteCount = state.userWriteCount;
        ssdState.gcWriteCount = state.gcWriteCount;
        ssdState.blockWriteCounter = {...state.blockWriteCounter};
        ssdState.globalWriteCounter = state.globalWriteCounter;

        window.SSDSimulator.renderer.renderSSD();
        window.SSDSimulator.utils.updateStatus();
        window.SSDSimulator.renderer.updateMappingTable();
        window.SSDSimulator.renderer.updateBlockStatsPanel();
        window.SSDSimulator.utils.addLog('重做操作', 'write');
        window.SSDSimulator.state.updateHistoryButtons();
    }
}

/**
 * 更新历史记录按钮状态
 */
function updateHistoryButtons() {
    document.getElementById('undoBtn').disabled = ssdState.historyIndex <= 0;
    document.getElementById('redoBtn').disabled = ssdState.historyIndex >= ssdState.history.length - 1;
    document.getElementById('historyPos').textContent = `${ssdState.historyIndex} / ${ssdState.history.length - 1}`;
}

/**
 * 重置SSD
 */
function resetSSD() {
    if (confirm('确定要重置SSD吗？这将清除所有数据和历史记录。')) {
        initSSD();
        document.getElementById('logContainer').innerHTML = '<div class="log-entry">SSD 已重置</div>';
    }
}

// 导出模块
window.SSDState = {
    // 状态
    ssdState,

    // 方法
    initSSD,
    getSuperBlockPages,
    getBlockPages,
    getFreePages,
    getInvalidPages,
    getFreePagesCount,
    getUsedPagesCount,
    getInvalidPagesCount,
    selectBestPsb,
    getFirstFreePageInPsb,
    isPsbFull,
    updateBlockWriteCounter,
    getBlockWriteAge,
    getBlockStats,
    saveState,
    undo,
    redo,
    updateHistoryButtons,
    resetSSD
};
