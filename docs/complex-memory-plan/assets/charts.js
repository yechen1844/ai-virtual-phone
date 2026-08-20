(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue("--accent").trim();
  var accent2 = style.getPropertyValue("--accent2").trim();
  var ink = style.getPropertyValue("--ink").trim();
  var muted = style.getPropertyValue("--muted").trim();
  var rule = style.getPropertyValue("--rule").trim();
  var bg2 = style.getPropertyValue("--bg2-solid").trim();

  var fontFamily = '"WorkSans", "PingFang SC", "Microsoft YaHei", sans-serif';

  // ---------- Chart 1: Voltage decay ----------
  var voltageEl = document.getElementById("chart-voltage");
  if (voltageEl && typeof echarts !== "undefined") {
    var days = 45;
    var noRecall = [];
    var withRecall = [];
    var v1 = 1.0;
    var v2 = 1.0;
    for (var d = 0; d <= days; d++) {
      noRecall.push([d, +v1.toFixed(4)]);
      if (d > 0 && d % 7 === 0) {
        v2 = Math.min(1.0, v2 + 0.1);
      }
      withRecall.push([d, +v2.toFixed(4)]);
      v1 = v1 * 0.98;
      v2 = v2 * 0.98;
    }
    var chart1 = echarts.init(voltageEl, null, { renderer: "svg" });
    chart1.setOption({
      animation: false,
      textStyle: { fontFamily: fontFamily },
      grid: { left: 56, right: 30, top: 40, bottom: 44 },
      tooltip: {
        appendToBody: true,
        trigger: "axis",
        valueFormatter: function (v) { return typeof v === "number" ? v.toFixed(3) : v; }
      },
      legend: {
        data: ["持续不被想起", "每 7 天被召回一次"],
        top: 4,
        textStyle: { color: muted, fontSize: 12 }
      },
      xAxis: {
        type: "value",
        name: "天数",
        nameTextStyle: { color: muted },
        min: 0, max: days,
        interval: 5,
        axisLine: { lineStyle: { color: rule } },
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: rule, type: "dashed" } }
      },
      yAxis: {
        type: "value",
        name: "有效电压",
        min: 0, max: 1.0,
        axisLine: { lineStyle: { color: rule } },
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          name: "持续不被想起",
          type: "line",
          showSymbol: false,
          smooth: false,
          step: false,
          lineStyle: { color: accent, width: 2.5 },
          itemStyle: { color: accent },
          areaStyle: { color: accent, opacity: 0.06 },
          data: noRecall,
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: "#c2603f", type: "dashed", width: 1.5 },
            label: { formatter: "消磨阈值 0.1", color: "#c2603f", fontSize: 11, position: "insideEndTop" },
            data: [{ yAxis: 0.1 }]
          }
        },
        {
          name: "每 7 天被召回一次",
          type: "line",
          showSymbol: false,
          smooth: false,
          lineStyle: { color: accent2, width: 2.5 },
          itemStyle: { color: accent2 },
          data: withRecall
        }
      ]
    });
    window.addEventListener("resize", function () { chart1.resize(); });
  }

  // ---------- Chart 2: Token budget ----------
  var budgetEl = document.getElementById("chart-budget");
  if (budgetEl && typeof echarts !== "undefined") {
    var items = [
      { name: "短期上下文窗口（120 条）", value: 8000 },
      { name: "向量召回注入（≤8 条重排后）", value: 2400 },
      { name: "核心记忆全文（1000 字）", value: 700 },
      { name: "昨日日记（800 字）", value: 550 },
      { name: "活跃周期摘要", value: 400 },
      { name: "最新事件记忆 ×2", value: 340 },
      { name: "生成预留", value: 500 }
    ];
    var total = items.reduce(function (s, it) { return s + it.value; }, 0);
    var chart2 = echarts.init(budgetEl, null, { renderer: "svg" });
    chart2.setOption({
      animation: false,
      textStyle: { fontFamily: fontFamily },
      grid: { left: 220, right: 90, top: 16, bottom: 34 },
      tooltip: {
        appendToBody: true,
        trigger: "item",
        formatter: function (p) {
          return p.name + "<br/>" + p.value.toLocaleString() + " token（估算）";
        }
      },
      xAxis: {
        type: "value",
        max: 24000,
        axisLine: { lineStyle: { color: rule } },
        axisLabel: {
          color: muted,
          formatter: function (v) { return v / 1000 + "k"; }
        },
        splitLine: { lineStyle: { color: rule } }
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: items.map(function (it) { return it.name; }),
        axisLine: { lineStyle: { color: rule } },
        axisLabel: { color: ink, fontSize: 12 },
        axisTick: { show: false }
      },
      series: [
        {
          type: "bar",
          barWidth: 18,
          data: items.map(function (it, i) {
            return {
              value: it.value,
              itemStyle: {
                color: i % 2 === 0 ? accent : accent2,
                borderRadius: [0, 4, 4, 0]
              }
            };
          }),
          label: {
            show: true,
            position: "right",
            color: muted,
            fontSize: 11,
            formatter: function (p) { return p.value.toLocaleString(); }
          },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: "#c2603f", type: "dashed", width: 1.5 },
            label: { formatter: "预算上限 24k（可调）", color: "#c2603f", fontSize: 11, position: "insideEndTop" },
            data: [{ xAxis: 24000 }]
          }
        }
      ],
      graphic: [
        {
          type: "text",
          right: 30,
          bottom: 8,
          style: {
            text: "固定注入区 + 召回区 合计估算 " + total.toLocaleString() + " token，预算内留有余量",
            fontSize: 11,
            fill: muted
          }
        }
      ]
    });
    window.addEventListener("resize", function () { chart2.resize(); });
  }

  // ---------- Mermaid ----------
  if (typeof mermaid !== "undefined") {
    mermaid.initialize({
      startOnLoad: true,
      theme: "neutral",
      securityLevel: "loose",
      themeVariables: {
        primaryColor: "#ffffff",
        primaryBorderColor: accent,
        primaryTextColor: ink,
        lineColor: "#9b93b5",
        fontSize: "14px",
        fontFamily: fontFamily
      },
      flowchart: { curve: "basis", padding: 14 }
    });
  }
})();
