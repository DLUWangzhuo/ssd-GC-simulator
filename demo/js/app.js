/**
 * 前端交互模块
 * 负责按钮事件绑定和初始化
 */

/**
 * 浮窗状态
 */
let floatPanelState = {
    isFloating: false,
    isDragging: false,
    offsetX: 0,
    offsetY: 0,
    posX: 0,
    posY: 0
};

/**
 * 初始化前端交互
 */
function initApp() {
    // 初始化SSD
    window.SSDSimulator.state.initSSD();

    // 初始化Block统计面板
    window.SSDSimulator.renderer.updateBlockStatsPanel();

    // 初始化浮窗面板拖动
    initFloatPanelDrag();

    console.log('SSD GC Simulator initialized');
}

/**
 * 切换操作控制面板的浮窗/停靠模式
 */
function toggleFloatPanel() {
    const panel = document.querySelector('.control-panel');
    const btn = document.getElementById('floatToggleBtn');
    const mainLayout = document.querySelector('.main-layout');

    if (!floatPanelState.isFloating) {
        // 进入浮窗模式
        const rect = panel.getBoundingClientRect();
        floatPanelState.posX = rect.left;
        floatPanelState.posY = rect.top;

        // 记录当前grid位置为初始浮窗位置
        panel.classList.add('floating');
        panel.style.left = floatPanelState.posX + 'px';
        panel.style.top = floatPanelState.posY + 'px';
        panel.style.width = '280px';
        btn.classList.add('active');
        mainLayout.classList.add('has-floating');

        floatPanelState.isFloating = true;
    } else {
        // 退出浮窗模式
        panel.classList.remove('floating');
        panel.style.left = '';
        panel.style.top = '';
        panel.style.width = '';
        btn.classList.remove('active');
        mainLayout.classList.remove('has-floating');

        floatPanelState.isFloating = false;
        floatPanelState.isDragging = false;
    }
}

/**
 * 初始化浮窗面板的拖拽功能
 */
function initFloatPanelDrag() {
    const panel = document.querySelector('.control-panel');

    // 按下开始拖拽
    panel.addEventListener('mousedown', function(e) {
        // 只有浮窗模式下才允许拖拽
        if (!floatPanelState.isFloating) return;

        // 点击的是按钮/输入框时不启动拖拽
        const tag = e.target.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.target.closest('.btn') || e.target.closest('.btn-float-toggle')) return;

        e.preventDefault();
        floatPanelState.isDragging = true;

        const rect = panel.getBoundingClientRect();
        floatPanelState.offsetX = e.clientX - rect.left;
        floatPanelState.offsetY = e.clientY - rect.top;

        panel.classList.add('dragging');
    });

    // 移动拖拽
    document.addEventListener('mousemove', function(e) {
        if (!floatPanelState.isDragging || !floatPanelState.isFloating) return;

        const newX = e.clientX - floatPanelState.offsetX;
        const newY = e.clientY - floatPanelState.offsetY;

        // 限制在视口内
        const panelWidth = 280;
        const panelHeight = panel.getBoundingClientRect().height;
        const clampedX = Math.max(0, Math.min(newX, window.innerWidth - panelWidth));
        const clampedY = Math.max(0, Math.min(newY, window.innerHeight - panelHeight));

        panel.style.left = clampedX + 'px';
        panel.style.top = clampedY + 'px';

        floatPanelState.posX = clampedX;
        floatPanelState.posY = clampedY;
    });

    // 释放结束拖拽
    document.addEventListener('mouseup', function() {
        if (floatPanelState.isDragging) {
            panel.classList.remove('dragging');
        }
        floatPanelState.isDragging = false;
    });

    // position: fixed 天然保持视口固定，无需额外scroll处理
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initApp);

// 导出模块
window.SSDApp = {
    initApp,
    toggleFloatPanel
};