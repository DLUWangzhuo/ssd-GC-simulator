/**
 * 前端交互模块
 * 负责按钮事件绑定和初始化
 */

/**
 * 初始化前端交互
 */
function initApp() {
    // 初始化SSD
    window.SSDSimulator.state.initSSD();

    // 初始化Block统计面板
    window.SSDSimulator.renderer.updateBlockStatsPanel();

    console.log('SSD GC Simulator initialized');
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initApp);

// 导出模块
window.SSDApp = {
    initApp
};