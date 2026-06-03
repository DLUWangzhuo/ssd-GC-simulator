/**
 * SSD 配置管理模块
 * 负责管理SSD模拟器的所有配置参数
 */

const CONFIG = {
    dieCount: 4,
    pagesPerBlock: 9,
    totalSuperBlocks: 6,
    opSuperBlocks: 1,
    gcThreshold: 0.20,     // 基于用户空间百分比阈值（已弃用）
    gcFreePagesThreshold: 0, // 基于空白页数量的GC阈值（0=满时触发）
    maxHistory: 100,
    displayCols: 2 // 每行显示的PSB数量
};

// 默认配置值
const DEFAULT_CONFIG = {
    totalSuperBlocks: 6,
    opSuperBlocks: 1,
    displayCols: 2,
    gcFreePagesThreshold: 0
};

/**
 * 更新派生配置值
 */
function updateConfigDerived() {
    CONFIG.pagesPerSuperBlock = CONFIG.dieCount * CONFIG.pagesPerBlock; // 4 × 9 = 36
    CONFIG.userPages = (CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks) * CONFIG.pagesPerSuperBlock;
    CONFIG.totalPages = CONFIG.totalSuperBlocks * CONFIG.pagesPerSuperBlock;
}

/**
 * 更新SSD配置（参数校验）
 */
function updateSSDConfig() {
    let totalSB = parseInt(document.getElementById('configTotalSB').value) || 5;
    let opSB = parseInt(document.getElementById('configOPSB').value) || 0;

    // 限制范围
    totalSB = Math.max(2, Math.min(20, totalSB));
    opSB = Math.max(0, Math.min(totalSB - 1, opSB));

    // 更新CONFIG
    CONFIG.totalSuperBlocks = totalSB;
    CONFIG.opSuperBlocks = opSB;
    updateConfigDerived();

    // 更新GC阈值建议值
    const gcInput = document.getElementById('gcFreePagesThreshold');
    gcInput.max = CONFIG.pagesPerSuperBlock;
    gcInput.value = Math.min(gcInput.value, CONFIG.pagesPerSuperBlock);
    CONFIG.gcFreePagesThreshold = parseInt(gcInput.value) || CONFIG.pagesPerSuperBlock;
}

/**
 * 应用配置（重新初始化SSD）
 */
function applyConfig() {
    if (confirm('应用新配置将重置SSD，是否继续？')) {
        updateSSDConfig();
        updateConfigSummary();
        window.SSDSimulator.initSSD();
        window.SSDSimulator.utils.addLog(`配置已应用: ${CONFIG.totalSuperBlocks}PSB, OP空间${CONFIG.opSuperBlocks}个, 每行${CONFIG.displayCols}个`, 'gc');
    }
}

/**
 * 恢复默认配置
 */
function resetToDefault() {
    document.getElementById('configTotalSB').value = DEFAULT_CONFIG.totalSuperBlocks;
    document.getElementById('configOPSB').value = DEFAULT_CONFIG.opSuperBlocks;
    document.getElementById('configDisplayMode').value = DEFAULT_CONFIG.displayCols.toString();
    document.getElementById('gcFreePagesThreshold').value = DEFAULT_CONFIG.gcFreePagesThreshold;
    window.SSDSimulator.utils.addLog('配置已恢复默认', 'gc');
}

/**
 * 更新显示模式
 */
function updateDisplayMode() {
    const mode = parseInt(document.getElementById('configDisplayMode').value);
    CONFIG.displayCols = mode;
    window.SSDSimulator.renderer.renderSSD();
}

/**
 * 更新配置摘要显示
 */
function updateConfigSummary() {
    const userPages = CONFIG.userPages;
    const opPages = CONFIG.opSuperBlocks * CONFIG.pagesPerSuperBlock;
    document.getElementById('configSummary').textContent =
        `${CONFIG.totalSuperBlocks} SB × ${CONFIG.dieCount} Die × ${CONFIG.pagesPerBlock} Page | 用户空间: ${userPages}页, OP空间: ${opPages}页`;

    // 更新状态概览
    const totalPagesEl = document.querySelector('.status-grid .status-item:nth-child(1) .value');
    const userPagesEl = document.querySelector('.status-grid .status-item:nth-child(2) .value');
    const opPagesEl = document.querySelector('.status-grid .status-item:nth-child(3) .value');

    if (totalPagesEl) totalPagesEl.textContent = CONFIG.totalPages;
    if (userPagesEl) userPagesEl.textContent = userPages;
    if (opPagesEl) opPagesEl.textContent = opPages;

    // 更新随机LBA范围显示
    const randomLbaMaxEl = document.getElementById('randomLbaMax');
    const randomLbaMax2El = document.getElementById('randomLbaMax2');
    if (randomLbaMaxEl) randomLbaMaxEl.textContent = userPages;
    if (randomLbaMax2El) randomLbaMax2El.textContent = userPages;
}

/**
 * 更新GC阈值
 */
function updateGCTreshold() {
    const value = parseInt(document.getElementById('gcFreePagesThreshold').value);
    CONFIG.gcFreePagesThreshold = value;
    window.SSDSimulator.utils.addLog(`GC阈值已更新: ${value} 页`, 'gc');
}

// 初始化派生值
updateConfigDerived();

// 导出模块
window.SSDConfig = {
    CONFIG,
    DEFAULT_CONFIG,
    updateConfigDerived,
    updateSSDConfig,
    applyConfig,
    resetToDefault,
    updateDisplayMode,
    updateConfigSummary,
    updateGCTreshold
};
