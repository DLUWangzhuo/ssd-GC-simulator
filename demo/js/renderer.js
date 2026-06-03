/**
 * 渲染模块
 * 负责SSD可视化界面和映射表的渲染
 */

/**
 * 渲染SSD可视化界面
 */
function renderSSD() {
    const grid = document.getElementById('ssdGrid');
    grid.innerHTML = '';

    // 设置显示列数
    grid.className = 'ssd-grid' + (CONFIG.displayCols === 2 ? ' cols-2' : '');

    for (let sb = 0; sb < CONFIG.totalSuperBlocks; sb++) {
        const isOp = sb >= CONFIG.totalSuperBlocks - CONFIG.opSuperBlocks;
        const sbPages = window.SSDSimulator.state.getSuperBlockPages(sb);
        const validCount = sbPages.filter(p => p.state === 'valid').length;
        const invalidCount = sbPages.filter(p => p.state === 'invalid').length;

        const sbDiv = document.createElement('div');
        sbDiv.className = 'superblock' + (isOp ? ' op' : '');

        sbDiv.innerHTML = `
            <div class="superblock-header">
                <div class="superblock-title">
                    ${isOp ? '⬡' : '▣'} Super Block ${sb} ${isOp ? '(OP预留空间)' : ''}
                </div>
                <div class="superblock-stats">
                    有效: ${validCount} | 无效: ${invalidCount} | 空: ${sbPages.length - validCount - invalidCount}
                </div>
            </div>
            <div class="blocks-row">
                ${Array.from({length: CONFIG.dieCount}, (_, die) => {
                    const diePages = sbPages.filter(p => p.die === die).sort((a, b) => a.page - b.page);
                    return `
                        <div class="block">
                            <div class="block-label">Die ${die}</div>
                            <div class="pages-grid">
                                ${diePages.map(p => `
                                    <div class="page ${p.state}" data-ppa="${p.ppa}">
                                        ${p.lpa !== null ? p.lpa : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        grid.appendChild(sbDiv);
    }
}

/**
 * 更新映射表显示
 */
function updateMappingTable() {
    const { ssdState } = window.SSDSimulator;
    const tbody = document.getElementById('mappingTable');
    tbody.innerHTML = '';

    const sortedLpas = Array.from(ssdState.lpaToPpa.keys()).sort((a, b) => a - b);

    for (const lpa of sortedLpas) {
        const ppa = ssdState.lpaToPpa.get(lpa);
        const page = ssdState.pages.find(p => p.ppa === ppa);

        if (page) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>LPA ${lpa}</td>
                <td>SB${page.sb} Die${page.die} Blk${page.block} Page${page.page}</td>
                <td style="color: var(--success);">有效</td>
            `;
            tbody.appendChild(tr);
        }
    }

    // Show invalid mappings
    ssdState.pages.filter(p => p.state === 'invalid' && p.lpa !== null).forEach(page => {
        const tr = document.createElement('tr');
        tr.style.opacity = '0.5';
        tr.innerHTML = `
            <td>LPA ${page.lpa}</td>
            <td>SB${page.sb} Die${page.die} Blk${page.block} Page${page.page}</td>
            <td style="color: var(--page-invalid);">无效</td>
        `;
        tbody.appendChild(tr);
    });

    if (tbody.children.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3" style="text-align: center; opacity: 0.5;">暂无有效映射</td>';
        tbody.appendChild(tr);
    }
}

/**
 * 更新Block Write Age统计面板
 * 按物理block（SB + Die）渲染柱状图
 * 每个柱子：灰色(下方)=有效页，红色(上方)=无效页
 */
function updateBlockStatsPanel() {
    const { state } = window.SSDSimulator;
    const chartContainer = document.getElementById('blockStatsChart');
    if (!chartContainer) return;

    const stats = state.getBlockStats();

    // 清空容器
    chartContainer.innerHTML = '';

    // 创建带Y轴的容器
    const chartWithAxis = document.createElement('div');
    chartWithAxis.className = 'stats-chart-with-axis';

    // 渲染Y轴标签
    const yAxisContainer = document.createElement('div');
    yAxisContainer.className = 'stats-y-axis';
    yAxisContainer.innerHTML = `
        <span>100%</span>
        <span>75%</span>
        <span>50%</span>
        <span>25%</span>
        <span>0%</span>
    `;

    // 渲染柱状图区域（横向滚动，不换行）
    const barsContainer = document.createElement('div');
    barsContainer.className = 'stats-bars-scroll-container';

    // 渲染柱状图
    stats.forEach(stat => {
        const barContainer = document.createElement('div');
        barContainer.className = 'stats-bar-container';

        // 柱状图（包含有效和无效两部分）
        const barWrapper = document.createElement('div');
        barWrapper.className = 'stats-bar-wrapper';

        // 计算有效和无效高度百分比
        const validHeight = (stat.validPercent / 100) * 120;
        // 正确计算无效页占比
        const invalidCount = stat.totalCount - stat.validCount;
        const invalidPercent = (invalidCount / stat.totalCount) * 100;
        const invalidHeight = (invalidPercent / 100) * 120;

        // 创建堆叠柱状图容器
        const stackedBar = document.createElement('div');
        stackedBar.className = 'stats-stacked-bar';

        // 有效部分（灰色，下方）
        const validBar = document.createElement('div');
        validBar.className = 'stats-bar-valid';
        validBar.style.height = `${validHeight}px`;

        // 无效部分（红色，上方）
        const invalidBar = document.createElement('div');
        invalidBar.className = 'stats-bar-invalid';
        invalidBar.style.height = `${invalidHeight}px`;

        // 先添加无效部分（红色，上方），再添加有效部分（灰色，下方）
        stackedBar.appendChild(invalidBar);
        stackedBar.appendChild(validBar);

        // Tooltip
        const tooltip = document.createElement('div');
        tooltip.className = 'stats-bar-tooltip';
        tooltip.innerHTML = `SB${stat.sb} Die${stat.die}${stat.isOp ? '(OP)' : ''}<br>Valid: ${stat.validPercent.toFixed(0)}% (${stat.validCount}/${stat.totalCount})<br>Invalid: ${invalidPercent.toFixed(0)}% (${invalidCount}/${stat.totalCount})<br>Age: ${stat.writeAge}`;

        stackedBar.appendChild(tooltip);
        barWrapper.appendChild(stackedBar);

        // 标签
        const label = document.createElement('div');
        label.className = 'stats-bar-label';
        label.textContent = `${stat.sb}_${stat.die}`;

        barContainer.appendChild(barWrapper);
        barContainer.appendChild(label);
        barsContainer.appendChild(barContainer);
    });

    chartWithAxis.appendChild(yAxisContainer);
    chartWithAxis.appendChild(barsContainer);
    chartContainer.appendChild(chartWithAxis);

    // 添加X轴标签
    const xAxisLabel = document.createElement('div');
    xAxisLabel.className = 'stats-axis-label';
    xAxisLabel.style.textAlign = 'center';
    xAxisLabel.style.width = '100%';
    xAxisLabel.innerHTML = '<span style="opacity: 0.6;">← block write age: Old</span>' +
        '<span style="margin: 0 20px; opacity: 0.3;">|</span>' +
        '<span style="opacity: 0.6;">block write age: Recent →</span>';
    chartContainer.appendChild(xAxisLabel);
}

// 导出模块
window.SSDRenderer = {
    renderSSD,
    updateMappingTable,
    updateBlockStatsPanel
};