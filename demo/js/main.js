/**
 * SSD GC Simulator - 主入口模块
 * 组装各子模块，提供统一的对外接口
 */

(function() {
    'use strict';

    // 等待所有依赖模块加载完成后组装
    function assembleModules() {
        // 确保所有依赖模块已加载
        if (typeof window.SSDConfig === 'undefined' ||
            typeof window.SSDState === 'undefined' ||
            typeof window.SSDUtils === 'undefined' ||
            typeof window.SSDWriteStrategy === 'undefined' ||
            typeof window.SSDGCStrategy === 'undefined' ||
            typeof window.SSDRenderer === 'undefined' ||
            typeof window.SSDApp === 'undefined' ||
            typeof window.SSDScriptStrategy === 'undefined') {
            console.error('Required modules not loaded');
            return;
        }

        // 组装SSD模拟器
        window.SSDSimulator = {
            // 状态
            get ssdState() { return window.SSDState.ssdState; },

            // 子模块
            config: window.SSDConfig,
            state: window.SSDState,
            utils: window.SSDUtils,
            writeStrategy: window.SSDWriteStrategy,
            gc: window.SSDGCStrategy,
            renderer: window.SSDRenderer,
            app: window.SSDApp,
            script: window.SSDScriptStrategy,

            // 便捷方法
            initSSD: function() {
                window.SSDState.initSSD();
            }
        };

        // 暴露全局函数（兼容原有调用方式）
        exposeGlobalFunctions();

        // 初始化应用
        window.SSDApp.initApp();

        console.log('SSD Simulator modules assembled successfully');
    }

    /**
     * 暴露全局函数（保持向后兼容）
     */
    function exposeGlobalFunctions() {
        // 配置相关
        window.updateSSDConfig = window.SSDConfig.updateSSDConfig;
        window.applyConfig = window.SSDConfig.applyConfig;
        window.resetToDefault = window.SSDConfig.resetToDefault;
        window.updateDisplayMode = window.SSDConfig.updateDisplayMode;
        window.updateConfigSummary = window.SSDConfig.updateConfigSummary;
        window.updateGCTreshold = window.SSDConfig.updateGCTreshold;

        // 状态相关
        window.initSSD = window.SSDState.initSSD;
        window.resetSSD = window.SSDState.resetSSD;
        window.undo = window.SSDState.undo;
        window.redo = window.SSDState.redo;

        // 写入策略
        window.sequentialWrite = window.SSDWriteStrategy.sequentialWrite;
        window.randomWrite = window.SSDWriteStrategy.randomWrite;

        // GC策略 - gcStepNext在gcStrategy.js的showGCSteps中动态设置
        // 这里不做覆盖，保持动态设置的有效性
    }

    // 等待DOM加载完成后组装模块
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            // 延迟确保所有模块脚本已执行
            setTimeout(assembleModules, 0);
        });
    } else {
        setTimeout(assembleModules, 0);
    }
})();