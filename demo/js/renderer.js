/**
 * 渲染模块
 * 负责SSD可视化界面和映射表的渲染
 */

// 拟合线显示状态
let showFitLine = false;
let showTargetLine = false;

/**
 * 计算线性回归（最小二乘法）
 * @param {Array} points - [{x, y}] 格式的点数组
 * @returns {object} {slope, intercept, r2} 斜率、截距和R²值
 */
function linearRegression(points) {
    if (points.length < 2) {
        return { slope: 0, intercept: 0, r2: 0 };
    }

    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

    for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
        sumY2 += p.y * p.y;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
        return { slope: 0, intercept: sumY / n, r2: 0 };
    }

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    // 计算 R²
    const meanY = sumY / n;
    let ssTotal = 0, ssResidual = 0;
    for (const p of points) {
        const predicted = slope * p.x + intercept;
        ssTotal += (p.y - meanY) * (p.y - meanY);
        ssResidual += (p.y - predicted) * (p.y - predicted);
    }
    const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;

    return { slope, intercept, r2 };
}

/**
 * 切换拟合线显示/隐藏
 */
function toggleFitLine() {
    showFitLine = !showFitLine;

    const toggleBtn = document.getElementById('fitLineToggle');
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', showFitLine);
    }

    // 重新渲染统计面板
    updateBlockStatsPanel();
}

/**
 * 切换目标拟合线显示/隐藏
 */
function toggleTargetLine() {
    showTargetLine = !showTargetLine;

    const toggleBtn = document.getElementById('targetLineToggle');
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', showTargetLine);
    }

    // 重新渲染统计面板
    updateBlockStatsPanel();
}

/**
 * 计算目标拟合线参数
 * 直线过 [0, 100% - (2 * OP空间容量) / 总容量] 和 (maxX, 100%) 两点
 * 坐标系与拟合线一致：x为数据点索引，y为validPercent
 * @param {number} maxX - x轴最大值（数据点数量-1）
 * @returns {object} {slope, intercept}
 */
function getTargetLineParams(maxX) {
    // OP空间容量占比 = OP SuperBlocks / 总 SuperBlocks
    const opRatio = CONFIG.opSuperBlocks / CONFIG.totalSuperBlocks;
    // y轴截距：x=0时的y值 = 100% - 2 * OP占比
    const intercept = Math.max(0, 100 - 2 * opRatio * 100);
    // 斜率：过(maxX, 100%)点，所以 slope = (100 - intercept) / maxX
    const slope = (100 - intercept) / maxX;
    return { slope, intercept };
}

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

    // 用于拟合线计算的数据点
    const dataPoints = [];

    // 渲染柱状图
    stats.forEach((stat, index) => {
        const barContainer = document.createElement('div');
        barContainer.className = 'stats-bar-container';

        // 柱状图（包含空白、有效、无效三部分）
        const barWrapper = document.createElement('div');
        barWrapper.className = 'stats-bar-wrapper';

        // 使用 stat 中已有的各状态数量
        const validPercent = (stat.validCount / stat.totalCount) * 100;
        const invalidPercent = (stat.invalidCount / stat.totalCount) * 100;
        const emptyPercent = (stat.emptyCount / stat.totalCount) * 100;

        // 记录数据点（用于拟合线）
        dataPoints.push({ x: index, y: validPercent });

        const validHeight = (validPercent / 100) * 120;
        const invalidHeight = (invalidPercent / 100) * 120;
        const emptyHeight = (emptyPercent / 100) * 120;

        // 创建堆叠柱状图容器
        const stackedBar = document.createElement('div');
        stackedBar.className = 'stats-stacked-bar';

        // 空白部分（白色，顶部100%刻度处，向下延伸）
        const emptyBar = document.createElement('div');
        emptyBar.className = 'stats-bar-empty';
        emptyBar.style.height = `${emptyHeight}px`;
        emptyBar.style.marginTop = '0px';

        // 有效部分（灰色，中层）
        const validBar = document.createElement('div');
        validBar.className = 'stats-bar-valid';
        validBar.style.height = `${validHeight}px`;

        // 无效部分（红色）绘制逻辑修改：
        // - 白色占比不为0%时，红色从白色下方开始，向下绘制
        // - 白色占比为0%时，红色从顶部100%开始，向下绘制
        const invalidBar = document.createElement('div');
        invalidBar.className = 'stats-bar-invalid';
        invalidBar.style.height = `${invalidHeight}px`;

        if (emptyPercent > 0) {
            // 白色占比不为0：红色从白色下方开始（紧贴灰色上方）
            // 向上偏移 invalidHeight（抵消 flex-end 堆叠）
            invalidBar.style.marginTop = `-${invalidHeight}px`;
        } else {
            // 白色占比为0：红色从顶部开始
            // 向上偏移 invalidHeight（抵消 flex-end 堆叠）
            invalidBar.style.marginTop = `-${invalidHeight}px`;
        }

        // 堆叠顺序：先放 invalid（flex-end会把valid推上去），再放valid，再放empty
        stackedBar.appendChild(invalidBar);
        stackedBar.appendChild(validBar);
        stackedBar.appendChild(emptyBar);

        // Tooltip
        const tooltip = document.createElement('div');
        tooltip.className = 'stats-bar-tooltip';
        tooltip.innerHTML = `SB${stat.sb} Die${stat.die}${stat.isOp ? '(OP)' : ''}<br>Empty: ${emptyPercent.toFixed(0)}% (${stat.emptyCount}/${stat.totalCount})<br>Valid: ${validPercent.toFixed(0)}% (${stat.validCount}/${stat.totalCount})<br>Invalid: ${invalidPercent.toFixed(0)}% (${stat.invalidCount}/${stat.totalCount})<br>Age: ${stat.writeAge}`;

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

    // 如果启用拟合线或目标线，添加SVG覆盖层
    if ((showFitLine && dataPoints.length >= 2) || showTargetLine) {
        const barWidth = 44;
        const svgWidth = stats.length * barWidth;
        const svgHeight = 120;

        // 创建SVG容器
        const svgContainer = document.createElement('div');
        svgContainer.className = 'fit-line-container';
        svgContainer.style.cssText = 'position: absolute; top: 0; left: 40px; width: ' + svgWidth + 'px; height: ' + svgHeight + 'px; pointer-events: none; z-index: 10;';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'fit-line-svg');
        svg.style.cssText = 'width: ' + svgWidth + 'px; height: ' + svgHeight + 'px;';
        svg.setAttribute('viewBox', '0 0 ' + svgWidth + ' ' + svgHeight);
        svg.setAttribute('preserveAspectRatio', 'none');

        const getX = (index) => index * barWidth + barWidth / 2;
        const getY = (validPercent) => svgHeight - validPercent * 1.2;

        // 绘制拟合线（亮绿色）
        if (showFitLine && dataPoints.length >= 2) {
            const regression = linearRegression(dataPoints);

            const x1 = getX(0);
            const y1 = getY(Math.max(0, Math.min(100, regression.slope * 0 + regression.intercept)));
            const x2 = getX(stats.length - 1);
            const y2 = getY(Math.max(0, Math.min(100, regression.slope * (stats.length - 1) + regression.intercept)));

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x1);
            line.setAttribute('y1', y1);
            line.setAttribute('x2', x2);
            line.setAttribute('y2', y2);
            line.setAttribute('class', 'fit-line-path');
            svg.appendChild(line);

            // 添加拟合线方程文本
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', '5');
            text.setAttribute('y', '12');
            text.setAttribute('class', 'fit-line-equation');
            const slopeStr = regression.slope >= 0 ? '+' + regression.slope.toFixed(2) : regression.slope.toFixed(2);
            const interceptStr = regression.intercept >= 0 ? '+' + regression.intercept.toFixed(1) : regression.intercept.toFixed(1);
            text.textContent = `y = ${slopeStr}x ${interceptStr} (R²=${regression.r2.toFixed(3)})`;
            svg.appendChild(text);
        }

        // 绘制目标拟合线（亮红色虚线）
        if (showTargetLine) {
            const maxX = stats.length - 1;
            const target = getTargetLineParams(maxX);

            const x1 = getX(0);
            const y1 = getY(Math.max(0, Math.min(100, target.slope * 0 + target.intercept)));
            const x2 = getX(maxX);
            const y2 = getY(100); // 目标线终点y=100%

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x1);
            line.setAttribute('y1', y1);
            line.setAttribute('x2', x2);
            line.setAttribute('y2', y2);
            line.setAttribute('class', 'target-line-path');
            svg.appendChild(line);

            // 添加目标线方程文本
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', '5');
            text.setAttribute('y', showFitLine ? '24' : '12');
            text.setAttribute('class', 'target-line-equation');
            const slopeStr = target.slope >= 0 ? '+' + target.slope.toFixed(2) : target.slope.toFixed(2);
            const interceptStr = target.intercept >= 0 ? '+' + target.intercept.toFixed(1) : target.intercept.toFixed(1);
            text.textContent = `目标: y = ${slopeStr}x ${interceptStr}`;
            svg.appendChild(text);
        }

        svgContainer.appendChild(svg);
        chartWithAxis.style.position = 'relative';
        chartWithAxis.appendChild(svgContainer);
    }

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
    updateBlockStatsPanel,
    toggleFitLine,
    toggleTargetLine
};