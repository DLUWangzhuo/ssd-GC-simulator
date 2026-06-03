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
    gcTriggerCount: 0 // GC触发次数
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

    // Create pages: 根据配置的SuperBlock数量，每个SB包含4个Die-Block，每个Block包含9页
    for (let sb = 0; sb < CONFIG.totalSuperBlocks; sb++) {
        for (let die = 0; die < CONFIG.dieCount; die++) {
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
    window.SSDSimulator.renderer.renderSSD();
    window.SSDSimulator.utils.updateStatus();
    window.SSDSimulator.renderer.updateMappingTable();
    window.SSDConfig.updateConfigSummary(); // 更新配置摘要显示
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
 * 保存当前状态用于撤销
 */
function saveState() {
    const stateCopy = {
        pages: ssdState.pages.map(p => ({...p})),
        lpaToPpa: new Map(ssdState.lpaToPpa),
        ppaToLpa: new Map(ssdState.ppaToLpa),
        sequentialLpa: ssdState.sequentialLpa,
        currentPsb: ssdState.currentPsb,
        gcTriggerCount: ssdState.gcTriggerCount
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

        window.SSDSimulator.renderer.renderSSD();
        window.SSDSimulator.utils.updateStatus();
        window.SSDSimulator.renderer.updateMappingTable();
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

        window.SSDSimulator.renderer.renderSSD();
        window.SSDSimulator.utils.updateStatus();
        window.SSDSimulator.renderer.updateMappingTable();
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
    getFreePages,
    getInvalidPages,
    getFreePagesCount,
    getUsedPagesCount,
    getInvalidPagesCount,
    selectBestPsb,
    getFirstFreePageInPsb,
    isPsbFull,
    saveState,
    undo,
    redo,
    updateHistoryButtons,
    resetSSD
};
