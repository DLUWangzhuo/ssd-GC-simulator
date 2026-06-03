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

// 导出模块
window.SSDRenderer = {
    renderSSD,
    updateMappingTable
};