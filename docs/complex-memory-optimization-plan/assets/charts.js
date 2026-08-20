// assets/charts.js — 复杂记忆系统优化计划书图表
(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var warn = style.getPropertyValue('--warn').trim();

  // ── Mermaid 初始化 ──
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
  }

  // ── 图表一：分层电压衰减曲线（120 天） ──
  var decayEl = document.getElementById('chart-decay');
  if (decayEl && window.echarts) {
    var days = [];
    for (var d = 0; d <= 120; d += 2) days.push(d);
    function seriesOf(factor) {
      return days.map(function (d) { return +(Math.pow(factor, d)).toFixed(4); });
    }
    var chartDecay = echarts.init(decayEl, null, { renderer: 'svg' });
    chartDecay.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        valueFormatter: function (v) { return Number(v).toFixed(3); }
      },
      legend: {
        data: ['事件（0.94/日，快衰减）', '周期（0.995/日，慢衰减）', '旧统一衰减（0.98/日，对照）'],
        bottom: 0,
        textStyle: { color: muted, fontSize: 12 }
      },
      grid: { left: 52, right: 26, top: 30, bottom: 64 },
      xAxis: {
        type: 'category',
        data: days,
        name: '不召回天数',
        nameLocation: 'end',
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLine: { lineStyle: { color: rule } },
        axisLabel: { color: muted, fontSize: 11 }
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        name: '有效电压',
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLine: { lineStyle: { color: rule } },
        splitLine: { lineStyle: { color: rule, type: 'dashed' } },
        axisLabel: { color: muted, fontSize: 11, formatter: function (v) { return v.toFixed(1); } }
      },
      series: [
        {
          name: '事件（0.94/日，快衰减）',
          type: 'line',
          data: seriesOf(0.94),
          symbol: 'none',
          lineStyle: { width: 3, color: accent },
          itemStyle: { color: accent },
          areaStyle: { color: accent + '18' }
        },
        {
          name: '周期（0.995/日，慢衰减）',
          type: 'line',
          data: seriesOf(0.995),
          symbol: 'none',
          lineStyle: { width: 3, color: accent2 },
          itemStyle: { color: accent2 }
        },
        {
          name: '旧统一衰减（0.98/日，对照）',
          type: 'line',
          data: seriesOf(0.98),
          symbol: 'none',
          lineStyle: { width: 2, color: muted, type: 'dashed' },
          itemStyle: { color: muted }
        },
        {
          name: '消磨阈值 0.1',
          type: 'line',
          data: days.map(function () { return 0.1; }),
          symbol: 'none',
          lineStyle: { width: 1.5, color: warn, type: 'dotted' },
          itemStyle: { color: warn },
          tooltip: { show: false }
        }
      ]
    });
    window.addEventListener('resize', function () { chartDecay.resize(); });
  }

  // ── 图表二：迁移 token 预估（四阶段堆叠） ──
  var migEl = document.getElementById('chart-migration');
  if (migEl && window.echarts) {
    var scopes = ['回溯 7 天', '回溯 30 天', '回溯 90 天', '回溯 365 天'];
    // 示例估算：按每日约 40 条时间线的典型角色
    var events = scopes.map(function (_, i) { return [2800, 12000, 36000, 146000][i]; });
    var dailies = scopes.map(function (_, i) { return [9800, 42000, 126000, 511000][i]; });
    var periods = scopes.map(function (_, i) { return [980, 4200, 12600, 51100][i]; });
    var core = [3000, 3000, 3000, 3000];

    function fmtK(v) {
      return v >= 10000 ? (v / 10000).toFixed(1) + ' 万' : Math.round(v / 1000) + 'k';
    }

    var chartMig = echarts.init(migEl, null, { renderer: 'svg' });
    chartMig.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        appendToBody: true,
        valueFormatter: function (v) { return fmtK(Number(v)) + ' tokens'; }
      },
      legend: {
        data: ['事件回溯', '日记补生成', '周期蒸馏', '核心条目化'],
        bottom: 0,
        textStyle: { color: muted, fontSize: 12 }
      },
      grid: { left: 66, right: 26, top: 30, bottom: 64 },
      xAxis: {
        type: 'category',
        data: scopes,
        axisLine: { lineStyle: { color: rule } },
        axisLabel: { color: ink, fontSize: 12.5, fontWeight: 600 }
      },
      yAxis: {
        type: 'value',
        name: '预估 tokens',
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLine: { lineStyle: { color: rule } },
        splitLine: { lineStyle: { color: rule, type: 'dashed' } },
        axisLabel: { color: muted, fontSize: 11, formatter: fmtK }
      },
      series: [
        { name: '事件回溯', type: 'bar', stack: 'total', data: events, barWidth: '42%', itemStyle: { color: accent, borderRadius: [0, 0, 0, 0] } },
        { name: '日记补生成', type: 'bar', stack: 'total', data: dailies, itemStyle: { color: accent2 } },
        { name: '周期蒸馏', type: 'bar', stack: 'total', data: periods, itemStyle: { color: muted, opacity: 0.55 } },
        { name: '核心条目化', type: 'bar', stack: 'total', data: core, itemStyle: { color: accent, opacity: 0.45, borderRadius: [6, 6, 0, 0] } }
      ]
    });
    window.addEventListener('resize', function () { chartMig.resize(); });
  }
})();
