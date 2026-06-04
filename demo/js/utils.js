/**
 * 工具函数模块
 * 负责日志记录、状态更新、高亮显示等辅助功能
 */

/**
 * 高亮显示页面（临时效果）
 */
function highlightPages(ppas) {
    ppas.forEach(ppa => {
        const pageEl = document.querySelector(`[data-ppa="${ppa}"]`);
        if (pageEl) {
            pageEl.classList.add('highlight');
            setTimeout(() => pageEl.classList.remove('highlight'), 500);
        }
    });
}

/**
 * 添加日志条目
 */
function addLog(message, type = '') {
    const container = document.getElementById('logContainer');
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    container.insertBefore(entry, container.firstChild);

    // Keep only last 50 entries
    while (container.children.length > 50) {
        container.removeChild(container.lastChild);
    }
}

/**
 * 更新状态显示
 */
function updateStatus() {
    const userSuperBlocks = CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;
    const userPages = userSuperBlocks * CONFIG.dieCount * CONFIG.pagesPerBlock;
    const freePages = window.SSDSimulator.state.getFreePagesCount();
    const usedPages = window.SSDSimulator.state.getUsedPagesCount();
    const invalidPages = window.SSDSimulator.state.getInvalidPagesCount();
    const freeRatio = Math.round((freePages / userPages) * 100);
    const { ssdState } = window.SSDSimulator.state;

    document.getElementById('freePages').textContent = freePages;
    document.getElementById('usedPages').textContent = usedPages;
    document.getElementById('invalidPages').textContent = invalidPages;
    document.getElementById('gcTriggerCount').textContent = ssdState.gcTriggerCount;
    document.getElementById('userWriteCount').textContent = ssdState.userWriteCount;
    document.getElementById('gcWriteCount').textContent = ssdState.gcWriteCount;
    document.getElementById('totalWriteCount').textContent = ssdState.userWriteCount + ssdState.gcWriteCount;

    const ratioEl = document.getElementById('freeRatio');
    ratioEl.textContent = freeRatio + '%';

    const ratioPercent = freeRatio / 100;
    if (ratioPercent < CONFIG.gcThreshold) {
        ratioEl.className = 'value danger';
    } else if (ratioPercent < CONFIG.gcThreshold * 1.5) {
        ratioEl.className = 'value warning';
    } else {
        ratioEl.className = 'value';
    }
}

/**
 * 获取各PSB的无效页统计
 */
function getPsbInvalidCounts() {
    const psbCounts = [];
    for (let sb = 0; sb < CONFIG.totalSuperBlocks; sb++) {
        const sbPages = window.SSDSimulator.state.getSuperBlockPages(sb);
        const invalidCount = sbPages.filter(p => p.state === 'invalid').length;
        const validCount = sbPages.filter(p => p.state === 'valid').length;
        const emptyCount = sbPages.filter(p => p.state === 'empty').length;
        const isOp = sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;
        psbCounts.push({sb, invalidCount, validCount, emptyCount, total: sbPages.length, isOp});
    }
    // 按无效页数量降序排序（GC优先选择无效页最多的SB）
    // 相同无效页数时，优先选择用户空间SB（非OP）
    psbCounts.sort((a, b) => {
        if (b.invalidCount !== a.invalidCount) {
            return b.invalidCount - a.invalidCount;
        }
        // 相同无效页数时，优先选择用户空间SB
        if (a.isOp !== b.isOp) {
            return a.isOp ? 1 : -1;
        }
        // 都为OP或都为用户空间时，按序号选择
        return a.sb - b.sb;
    });
    return psbCounts;
}

// 导出模块
window.SSDUtils = {
    highlightPages,
    addLog,
    updateStatus,
    getPsbInvalidCounts
};
