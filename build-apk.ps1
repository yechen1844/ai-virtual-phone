﻿﻿﻿# ============================================================
#  Roche APK 一键打包脚本 (PowerShell 版)
#  双击 build-apk.cmd 即可运行
# ============================================================

# 不使用 Stop，改用 Continue，自己处理错误，避免闪退
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "      Roche APK 一键打包脚本 v3.1" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 顶层 try/catch，捕获所有未处理错误，防止闪退
try {

# ============================================================
# 第 0 步：定位脚本所在目录
# ============================================================
# 优先用 $PSScriptRoot，兼容各种调用方式
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}
$ScriptDir = [System.IO.Path]::GetFullPath($ScriptDir)

Write-Host "[信息] 脚本目录: $ScriptDir" -ForegroundColor Gray

# 搜索项目目录（支持多种位置）
$ProjectDir = $null

# 候选位置列表（优先使用脚本目录下的"需要打包版文件"）
$projectCandidates = @(
    (Join-Path $ScriptDir "需要打包版文件")
)

# 遍历候选位置，找到第一个有 dist/index.html 的
foreach ($candidate in $projectCandidates) {
    if ([string]::IsNullOrEmpty($candidate)) { continue }
    $testDist = Join-Path $candidate "dist\index.html"
    if (Test-Path $testDist) {
        $ProjectDir = $candidate
        break
    }
}

# 如果以上没找到，在脚本目录及上级搜索包含 dist 的文件夹
if (-not $ProjectDir) {
    $searchDirs = @($ScriptDir, (Split-Path -Parent $ScriptDir))
    foreach ($searchDir in $searchDirs) {
        if ($searchDir -and (Test-Path $searchDir)) {
            $subDirs = Get-ChildItem $searchDir -Directory -ErrorAction SilentlyContinue
            foreach ($d in $subDirs) {
                $testDist = Join-Path $d.FullName "dist\index.html"
                if (Test-Path $testDist) {
                    $ProjectDir = $d.FullName
                    break
                }
            }
        }
        if ($ProjectDir) { break }
    }
}

if ($ProjectDir) {
    Write-Host "[信息] 项目目录: $ProjectDir" -ForegroundColor Gray
} else {
    Write-Host "[信息] 未找到项目目录" -ForegroundColor Gray
}
Write-Host ""

# ============================================================
# 第 1 步：检查环境
# ============================================================
Write-Host "[1/6] 检查环境..." -ForegroundColor Yellow

# 1.1 检查 Node.js
$nodeVersion = $null
try {
    $nodeVersion = (node -v 2>$null)
} catch {}
if (-not $nodeVersion) {
    Write-Host "  [失败] 未找到 Node.js！" -ForegroundColor Red
    Write-Host "  请安装 Node.js 18+: https://nodejs.org/" -ForegroundColor Yellow
    throw "Node.js not found"
}
Write-Host "  [OK] Node.js: $nodeVersion" -ForegroundColor Green

# 1.2 检查 JDK（自动搜索多个位置）
$javaHome = $null
$javaExe = $null

# 候选 JDK 路径列表
$javaCandidates = @()

# 1) 环境变量 JAVA_HOME
if ($env:JAVA_HOME -and (Test-Path $env:JAVA_HOME)) {
    $javaCandidates += $env:JAVA_HOME
}

# 2) PATH 中的 java
try {
    $pathJava = (Get-Command java -ErrorAction SilentlyContinue).Source
    if ($pathJava) {
        $javaCandidates += (Split-Path (Split-Path $pathJava -Parent) -Parent)
    }
} catch {}

# 3) 常见安装位置
$commonPaths = @(
    "C:\Program Files\Java\*",
    "C:\Program Files (x86)\Java\*",
    "C:\Program Files\Eclipse Adoptium\*",
    "C:\Program Files\Microsoft\jdk-*",
    "C:\Program Files\Amazon Corretto\*",
    "C:\Program Files\Zulu\*",
    "C:\Program Files\BellSoft\Liberica JDK\*",
    "C:\Program Files\Java\jdk*"
)
foreach ($pattern in $commonPaths) {
    try {
        $found = Get-Item $pattern -ErrorAction SilentlyContinue
        foreach ($f in $found) { $javaCandidates += $f.FullName }
    } catch {}
}

# 4) IntelliJ IDEA / Android Studio 自带 JBR
try {
    $jbrPaths = @(
        "C:\Program Files\JetBrains\*\jbr",
        "C:\Program Files\Android\Android Studio\jbr",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
        "$env:LOCALAPPDATA\JetBrains\*\jbr"
    )
    foreach ($pattern in $jbrPaths) {
        $found = Get-Item $pattern -ErrorAction SilentlyContinue
        foreach ($f in $found) { $javaCandidates += $f.FullName }
    }
} catch {}

# 5) IntelliJ IDEA 下载的 JDK (用户目录 .jdks)
try {
    $jdksPath = Join-Path $env:USERPROFILE ".jdks\*"
    $found = Get-Item $jdksPath -ErrorAction SilentlyContinue
    foreach ($f in $found) { $javaCandidates += $f.FullName }
} catch {}

# 去重
$javaCandidates = $javaCandidates | Select-Object -Unique

$javaHomeFallback = $null

# 遍历候选路径，找到第一个可用的 JDK 17+
foreach ($candidate in $javaCandidates) {
    if (-not $candidate) { continue }
    $testJava = Join-Path $candidate "bin\java.exe"
    if (-not (Test-Path $testJava)) { continue }

    try {
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo.FileName = $testJava
        $process.StartInfo.Arguments = "-version"
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.CreateNoWindow = $true
        $process.Start() | Out-Null
        $javaOutput = $process.StandardError.ReadToEnd()
        $process.WaitForExit()

        # 解析版本号
        $javaMajor = 0
        if ($javaOutput -match 'version "(\d+)\.(\d+)') {
            $major = [int]$Matches[1]
            $minor = [int]$Matches[2]
            if ($major -eq 1) {
                $javaMajor = $minor  # Java 8 格式: 1.8.0
            } else {
                $javaMajor = $major  # Java 9+ 格式
            }
        } elseif ($javaOutput -match 'version "(\d+)') {
            $javaMajor = [int]$Matches[1]
        }

        if ($javaMajor -ge 21) {
            $jlinkPath = Join-Path $candidate "bin\jlink.exe"
            $hasJlink = Test-Path $jlinkPath
            if ($hasJlink) {
                $javaHome = $candidate
                $javaExe = $testJava
                Write-Host "  [OK] JDK: $javaMajor ($candidate) [jlink: yes]" -ForegroundColor Green
                break
            } else {
                Write-Host "  [跳过] JDK: $javaMajor ($candidate) [jlink: no]" -ForegroundColor Gray
                if (-not $javaHomeFallback) { $javaHomeFallback = $candidate }
            }
        } elseif ($javaMajor -ge 17) {
            # JDK 17 可以用，但 capacitor-filesystem 8.1.2 需要 JDK 21
            # 记录为备选，优先找 21+
            if (-not $javaHomeFallback) {
                $jlinkPath17 = Join-Path $candidate "bin\jlink.exe"
                if (Test-Path $jlinkPath17) { $javaHomeFallback = $candidate }
            }
            Write-Host "  [警告] JDK $javaMajor ($candidate) - 版本偏低，capacitor-filesystem 需要 JDK 21+" -ForegroundColor Yellow
        }
    } catch {
        continue
    }
}

# 如果没有找到 JDK 21+，使用 JDK 17/18/19/20 备选（依赖 foojay-resolver 自动下载 JDK 21）
if (-not $javaHome -and $javaHomeFallback) {
    $javaHome = $javaHomeFallback
    $javaExe = Join-Path $javaHome "bin\java.exe"
    Write-Host "  [警告] 使用 JDK 17/18/19/20: $javaHome" -ForegroundColor Yellow
    Write-Host "  capacitor-filesystem 需要 JDK 21，脚本将尝试通过 foojay-resolver 自动下载" -ForegroundColor Yellow
    Write-Host "  如果自动下载失败，请手动安装 JDK 21+: https://adoptium.net/temurin/releases/?version=21" -ForegroundColor Yellow
}

if (-not $javaHome) {
    Write-Host "  [失败] 未找到 JDK 17+！" -ForegroundColor Red
    Write-Host ""
    Write-Host "  已搜索以下路径，均未找到合适的 JDK:" -ForegroundColor Yellow
    foreach ($c in $javaCandidates) { Write-Host "    - $c" -ForegroundColor Gray }
    Write-Host ""
    Write-Host "  请安装 JDK 21+: https://adoptium.net/temurin/releases/?version=21" -ForegroundColor Yellow
    throw "JDK not found"
}

# 设置 JAVA_HOME 给 Gradle 使用
$env:JAVA_HOME = $javaHome
Write-Host "  [信息] 已设置 JAVA_HOME = $javaHome" -ForegroundColor Gray

# 1.3 检查 Android SDK（自动搜索多个位置）
$androidHome = $env:ANDROID_HOME
if (-not $androidHome -or -not (Test-Path $androidHome)) {
    $sdkCandidates = @(
        "$env:LOCALAPPDATA\Android\Sdk",
        (Join-Path (Split-Path -Parent $ScriptDir) "android-sdk"),
        (Join-Path $ScriptDir "android-sdk"),
        "C:\Android\Sdk",
        "D:\Android\Sdk",
        "E:\Android\Sdk"
    )
    foreach ($sdkPath in $sdkCandidates) {
        if ($sdkPath -and (Test-Path $sdkPath)) {
            if ((Test-Path (Join-Path $sdkPath "platforms")) -or (Test-Path (Join-Path $sdkPath "platform-tools"))) {
                $androidHome = $sdkPath
                break
            }
        }
    }
}
if ($androidHome -and (Test-Path $androidHome)) {
    $env:ANDROID_HOME = $androidHome
    $env:ANDROID_SDK_ROOT = $androidHome
    Write-Host "  [OK] Android SDK: $androidHome" -ForegroundColor Green
} else {
    Write-Host "  [警告] 未找到 Android SDK" -ForegroundColor Yellow
    Write-Host "  请安装 Android Studio: https://developer.android.com/studio" -ForegroundColor Yellow
    Write-Host "  安装后设置环境变量 ANDROID_HOME" -ForegroundColor Yellow
}

Write-Host ""

# ============================================================
# 第 2 步：检查项目文件
# ============================================================
Write-Host "[2/6] 检查项目文件..." -ForegroundColor Yellow

# 修复：先检查 $ProjectDir 是否为 null，避免 Test-Path $null 崩溃
if (-not $ProjectDir) {
    Write-Host "  [失败] 未找到项目目录！" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请将 Roche 的"打包版文件"文件夹放在本脚本同目录下，" -ForegroundColor Yellow
    Write-Host "  并将文件夹命名为: 需要打包版文件" -ForegroundColor Yellow
    Write-Host "  （文件夹内必须包含 dist/index.html）" -ForegroundColor Yellow
    Write-Host ""
    throw "Project directory not found"
}

if (-not (Test-Path $ProjectDir)) {
    Write-Host "  [失败] 项目目录不存在: $ProjectDir" -ForegroundColor Red
    throw "Project directory does not exist"
}

$distIndex = Join-Path $ProjectDir "dist\index.html"
$androidDir = Join-Path $ProjectDir "android"

if (-not (Test-Path $distIndex)) {
    Write-Host "  [失败] 缺少 Web 构建文件: $distIndex" -ForegroundColor Red
    Write-Host "  请确保"打包版文件"文件夹内有 dist/index.html" -ForegroundColor Yellow
    throw "dist/index.html not found"
}

if (-not (Test-Path $androidDir)) {
    Write-Host "  [信息] 缺少 Android 项目，正在自动创建..." -ForegroundColor Yellow
    Set-Location $ProjectDir
    if (-not (Test-Path "node_modules")) {
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [失败] 依赖安装失败！" -ForegroundColor Red
            throw "npm install failed"
        }
    }
    npx cap add android
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [失败] 创建 Android 项目失败！" -ForegroundColor Red
        throw "cap add android failed"
    }
    Write-Host "  [OK] Android 项目已创建" -ForegroundColor Green

    # 立即替换 Gradle 下载源为国内镜像（必须在第一次运行 gradlew 之前）
    $newWrapperProps = Join-Path $androidDir "gradle\wrapper\gradle-wrapper.properties"
    if (Test-Path $newWrapperProps) {
        $wContent = Get-Content $newWrapperProps -Raw -Encoding UTF8
        if ($wContent -match 'services\.gradle\.org') {
            $wContent = $wContent -replace 'services\.gradle\.org/distributions', 'mirrors.cloud.tencent.com/gradle'
            $utf8NoBomW = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($newWrapperProps, $wContent, $utf8NoBomW)
            Write-Host "  [OK] Gradle 下载源已替换为腾讯云镜像" -ForegroundColor Green
        }
    }
}

# 2.0.1 即使 android 目录已存在，也强制确保 Gradle 镜像生效（用户可能用旧项目）
$existWrapperProps = Join-Path $androidDir "gradle\wrapper\gradle-wrapper.properties"
if (Test-Path $existWrapperProps) {
    $eContent = Get-Content $existWrapperProps -Raw -Encoding UTF8
    if ($eContent -match 'services\.gradle\.org') {
        $eContent = $eContent -replace 'services\.gradle\.org/distributions', 'mirrors.cloud.tencent.com/gradle'
        $utf8NoBomE = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($existWrapperProps, $eContent, $utf8NoBomE)
        Write-Host "  [OK] Gradle 下载源已替换为腾讯云镜像（已存在项目）" -ForegroundColor Green
    }
    # 清理损坏的 gradle 缓存（zip END header not found）
    $gradleUserHome = $env:GRADLE_USER_HOME
    if (-not $gradleUserHome) { $gradleUserHome = Join-Path $env:USERPROFILE ".gradle" }
    $distsDir = Join-Path $gradleUserHome "wrapper\dists"
    if (Test-Path $distsDir) {
        try {
            Get-ChildItem $distsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                $zipFile = Join-Path $_.FullName "gradle-8.14.3-all.zip"
                $needClean = $false
                if (Test-Path $zipFile) {
                    $zipSize = (Get-Item $zipFile).Length
                    if ($zipSize -lt 1000000) { $needClean = $true }
                } else {
                    $needClean = $true
                }
                if ($needClean) {
                    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                    Write-Host "  [清理] 已删除损坏的 Gradle 缓存: $($_.Name)" -ForegroundColor Gray
                }
            }
        } catch {}
    }
}

# 2.1 确保 res/raw/silence.wav 存在（保活音频）
$rawDir = Join-Path $ProjectDir "android\app\src\main\res\raw"
$silenceWav = Join-Path $rawDir "silence.wav"
$sourceSilence = Join-Path $ScriptDir "keepalive-plugin\silence.wav"

if (-not (Test-Path $silenceWav)) {
    Write-Host "  [信息] res/raw/silence.wav 不存在，正在复制..." -ForegroundColor Gray
    if (-not (Test-Path $rawDir)) {
        New-Item -ItemType Directory -Force -Path $rawDir | Out-Null
    }
    if (Test-Path $sourceSilence) {
        Copy-Item $sourceSilence -Destination $silenceWav -Force
        Write-Host "  [OK] 已复制 silence.wav (20秒静音音频)" -ForegroundColor Green
    } else {
        Write-Host "  [警告] 未找到 silence.wav 源文件: $sourceSilence" -ForegroundColor Yellow
    }
} else {
    Write-Host "  [OK] res/raw/silence.wav 已存在" -ForegroundColor Green
}

Write-Host "  [OK] 项目文件完整" -ForegroundColor Green
Write-Host ""

# ============================================================
# 第 3 步：安装 Node.js 依赖
# ============================================================
Write-Host "[3/6] 安装 Node.js 依赖..." -ForegroundColor Yellow

Set-Location $ProjectDir

$needInstall = $false
if (-not (Test-Path "node_modules")) {
    $needInstall = $true
} elseif (-not (Test-Path "node_modules\@capacitor-community\bluetooth-le")) {
    $needInstall = $true
    Write-Host "  [信息] 检测到蓝牙插件未安装，需要重新安装依赖" -ForegroundColor Yellow
}

if ($needInstall) {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [失败] 依赖安装失败！" -ForegroundColor Red
        throw "npm install failed"
    }
    Write-Host "  [OK] 依赖安装完成" -ForegroundColor Green
} else {
    Write-Host "  [跳过] node_modules 已存在且完整" -ForegroundColor Gray
}

# 强制安装蓝牙插件（用户的干净 package.json 不包含此插件）
$blePath = Join-Path $ProjectDir "node_modules\@capacitor-community\bluetooth-le"
if (-not (Test-Path $blePath)) {
    Write-Host "  [信息] 安装蓝牙插件 @capacitor-community/bluetooth-le..." -ForegroundColor Yellow
    npm install @capacitor-community/bluetooth-le@^8.2.0 --save
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [警告] 蓝牙插件安装失败，继续尝试..." -ForegroundColor Yellow
    } else {
        Write-Host "  [OK] 蓝牙插件安装完成" -ForegroundColor Green
    }
} else {
    Write-Host "  [OK] 蓝牙插件已安装" -ForegroundColor Gray
}
Write-Host ""

# ============================================================
# 第 3.4 步：注入 native-audio-bridge.js 到 dist（cap sync 前注入，确保被打包进 APK）
# 关键：必须内联注入（<script>...</script>），而非 src 引用。
# 原因：PWA Service Worker 会缓存旧 index.html，src 引用的 bridge 永远不会被加载。
# 内联到 index.html 里，SW 缓存的 index.html 本身就包含 bridge 代码。
# ============================================================
Write-Host "[3.4/6] 注入原生音频桥接到 dist..." -ForegroundColor Yellow

$sourceBridge = Join-Path $ScriptDir "keepalive-plugin\native-audio-bridge.js"
$distDir = Join-Path $ProjectDir "dist"
$destBridge = Join-Path $distDir "native-audio-bridge.js"
$distIndex = Join-Path $distDir "index.html"
$bridgeMarker = '/* ROCHE_NATIVE_AUDIO_BRIDGE_INLINE */'

if (Test-Path $sourceBridge) {
    # 仍然复制一份 bridge 文件到 dist（备用，供调试用）
    if (Test-Path $distDir) {
        Copy-Item $sourceBridge $destBridge -Force
        Write-Host "  [OK] 已复制 native-audio-bridge.js 到 dist/" -ForegroundColor Green
    }

    # 读取 bridge 内容
    $bridgeContent = Get-Content $sourceBridge -Raw -Encoding UTF8

    # 注入到 index.html：内联 <script> 标签
    if (Test-Path $distIndex) {
        $indexContent = Get-Content $distIndex -Raw -Encoding UTF8
        $inlineScript = "<script>$bridgeMarker`n$bridgeContent`n</script>"

        # 先移除已有的 bridge 块（如果有）
        $pattern = '(?s)<script>/\* ROCHE_NATIVE_AUDIO_BRIDGE_INLINE \*/.*?</script>'
        $indexContent = [regex]::Replace($indexContent, $pattern, '')

        # 同时移除旧的 src 引用（向后兼容）
        $indexContent = $indexContent -replace '<script src="\./native-audio-bridge\.js"></script>\s*', ''

        # 注入新的内联 bridge
        if ($indexContent -match '</head>') {
            $indexContent = $indexContent -replace '</head>', "$inlineScript`n</head>"
        } elseif ($indexContent -match '</body>') {
            $indexContent = $indexContent -replace '</body>', "$inlineScript`n</body>"
        }

        $utf8NoBomBridge = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($distIndex, $indexContent, $utf8NoBomBridge)
        Write-Host "  [OK] 已内联注入 bridge 代码到 dist/index.html" -ForegroundColor Green
    }
} else {
    Write-Host "  [警告] 未找到 native-audio-bridge.js 源文件: $sourceBridge" -ForegroundColor Yellow
}
Write-Host ""

# ============================================================
# 第 3.4.1 步：注入 roche-optimizer.js 到 dist（性能优化，防止大存储 OOM）
# 同样使用内联注入，避免 SW 缓存问题
# ============================================================
Write-Host "[3.4.1/6] 注入性能优化脚本到 dist..." -ForegroundColor Yellow

$sourceOptimizer = Join-Path $ScriptDir "keepalive-plugin\roche-optimizer.js"
$destOptimizer = Join-Path $distDir "roche-optimizer.js"
$optimizerMarker = '/* ROCHE_OPTIMIZER_INLINE */'

if (Test-Path $sourceOptimizer) {
    # 复制一份到 dist（备用）
    if (Test-Path $distDir) {
        Copy-Item $sourceOptimizer $destOptimizer -Force
        Write-Host "  [OK] 已复制 roche-optimizer.js 到 dist/" -ForegroundColor Green
    }

    # 读取 optimizer 内容
    $optimizerContent = Get-Content $sourceOptimizer -Raw -Encoding UTF8

    # 注入到 index.html：内联 <script> 标签
    if (Test-Path $distIndex) {
        $indexContent = Get-Content $distIndex -Raw -Encoding UTF8
        $inlineOptimizer = "<script>$optimizerMarker`n$optimizerContent`n</script>"

        # 先移除已有的 optimizer 块（如果有）
        $patternOpt = '(?s)<script>/\* ROCHE_OPTIMIZER_INLINE \*/.*?</script>'
        $indexContent = [regex]::Replace($indexContent, $patternOpt, '')

        # 同时移除旧的 src 引用（向后兼容）
        $indexContent = $indexContent -replace '<script src="\./roche-optimizer\.js"></script>\s*', ''
        # 移除 roche-profiler.js 引用（调试工具，不应出现在生产环境）
        $indexContent = $indexContent -replace '<script src="\./roche-profiler\.js"></script>\s*', ''

        # 注入新的内联 optimizer
        # 位置：在 <meta charset> 之后（避免编码问题），在其他脚本之前（确保拦截 indexedDB）
        if ($indexContent -match '<meta\s+charset[^>]*>') {
            $indexContent = [regex]::Replace($indexContent, '<meta\s+charset[^>]*>', "`$0`n$inlineOptimizer", 1)
        } elseif ($indexContent -match '<head[^>]*>') {
            $indexContent = [regex]::Replace($indexContent, '<head[^>]*>', "`$0`n$inlineOptimizer", 1)
        } elseif ($indexContent -match '</head>') {
            $indexContent = $indexContent -replace '</head>', "$inlineOptimizer`n</head>"
        }

        $utf8NoBomOpt = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($distIndex, $indexContent, $utf8NoBomOpt)
        Write-Host "  [OK] 已内联注入 roche-optimizer.js 到 dist/index.html" -ForegroundColor Green
    }
} else {
    Write-Host "  [警告] 未找到 roche-optimizer.js 源文件: $sourceOptimizer" -ForegroundColor Yellow
}
Write-Host ""

# ============================================================
# 第 3.4.2 步：注入 roche-conv-sync-fix.js（修复新建角色+思维链崩溃）
# 修复 "Cannot read properties of undefined (reading 'localSettings')" 错误
# ============================================================
Write-Host "[3.4.2/6] 注入对话同步修复脚本..." -ForegroundColor Yellow

$sourceConvSync = Join-Path $ScriptDir "需要打包版文件\dist\roche-conv-sync-fix.js"
$destConvSync = Join-Path $distDir "roche-conv-sync-fix.js"

if (Test-Path $sourceConvSync) {
    # 复制到 dist（确保存在）
    if (Test-Path $distDir) {
        Copy-Item $sourceConvSync $destConvSync -Force
    }

    # 注入 script 引用到 index.html（在主程序之前）
    if (Test-Path $distIndex) {
        $indexContent = Get-Content $distIndex -Raw -Encoding UTF8
        $convSyncTag = '<script src="./roche-conv-sync-fix.js"></script>'

        # 移除已有的引用（避免重复）
        $indexContent = $indexContent -replace '<script src="\./roche-conv-sync-fix\.js"></script>\s*', ''

        # 在主程序 script 标签之前插入
        if ($indexContent -match '<script\s+type="module"\s+crossorigin\s+src="\./assets/index-[^"]+\.js"></script>') {
            $indexContent = [regex]::Replace($indexContent, '<script\s+type="module"\s+crossorigin\s+src="\./assets/index-[^"]+\.js"></script>', "$convSyncTag`n  `$0", 1)
            $utf8NoBomCS = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($distIndex, $indexContent, $utf8NoBomCS)
            Write-Host "  [OK] 已注入 roche-conv-sync-fix.js 到 dist/index.html" -ForegroundColor Green
        } else {
            Write-Host "  [警告] 未找到主程序 script 标签，跳过注入" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  [警告] 未找到 roche-conv-sync-fix.js: $sourceConvSync" -ForegroundColor Yellow
}
Write-Host ""

# ============================================================
# 第 3.4.3 步：禁用 PWA Service Worker（防止覆盖安装后 WebView 加载旧版）
# 根因：PWA SW 缓存 index.html + assets，导航请求走 cache-first 返回旧版
# 方案：①移除 registerSW.js 注册标签 ②注入内联 SW-killer ③用自毁型 sw.js 替换原 workbox SW
# ============================================================
Write-Host "[3.4.3/6] 禁用 PWA Service Worker..." -ForegroundColor Yellow

# 自毁型 SW 内容：安装时 skipWaiting，激活时注销自身+清空所有缓存+通知客户端刷新
$swSelfDestruct = @"
// Roche SW Killer - 自毁型 Service Worker
// 替换原 workbox SW，安装后立即注销自身并清除所有缓存
self.addEventListener('install', function(e) {
  self.skipWaiting();
});
self.addEventListener('activate', function(e) {
  e.waitUntil(Promise.all([
    self.registration.unregister(),
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }),
    self.clients.claim()
  ]).then(function() {
    return self.clients.matchAll({type: 'window'}).then(function(clients) {
      clients.forEach(function(c) { try { c.navigate(c.url); } catch(_) {} });
    });
  }));
});
"@

# 内联 SW-killer 脚本：在页面加载时主动注销所有 SW + 清空所有 caches
$swKillerInline = @"
<script id="roche-sw-killer">/* ROCHE_SW_KILLER_INLINE */
(function(){
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(rs){
      rs.forEach(function(r){ r.unregister(); });
    }).catch(function(){});
  }
  if (window.caches) {
    caches.keys().then(function(ks){
      ks.forEach(function(k){ caches.delete(k); });
    }).catch(function(){});
  }
})();
</script>
"@

# 处理 dist/index.html
if (Test-Path $distIndex) {
    $swIndexContent = Get-Content $distIndex -Raw -Encoding UTF8

    # 1. 移除 registerSW.js 注册标签（含 vite-plugin-pwa 标识和其他形式）
    $swIndexContent = $swIndexContent -replace '<script id="vite-plugin-pwa:register-sw"[^>]*>\s*</script>\s*', ''
    $swIndexContent = $swIndexContent -replace '<script[^>]*src="[^"]*registerSW\.js"[^>]*>\s*</script>\s*', ''

    # 2. 移除已有的 SW-killer 块（避免重复注入）
    $swIndexContent = [regex]::Replace($swIndexContent, '(?s)<script id="roche-sw-killer">/\* ROCHE_SW_KILLER_INLINE \*/.*?</script>\s*', '')

    # 3. 注入 SW-killer 到 <meta charset> 之后（最早执行，先于 optimizer）
    if ($swIndexContent -match '<meta\s+charset[^>]*>') {
        $swIndexContent = [regex]::Replace($swIndexContent, '<meta\s+charset[^>]*>', "`$0`n$swKillerInline", 1)
    } elseif ($swIndexContent -match '<head[^>]*>') {
        $swIndexContent = [regex]::Replace($swIndexContent, '<head[^>]*>', "`$0`n$swKillerInline", 1)
    } elseif ($swIndexContent -match '</head>') {
        $swIndexContent = $swIndexContent -replace '</head>', "$swKillerInline`n</head>"
    }

    $utf8NoBomSWIdx = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($distIndex, $swIndexContent, $utf8NoBomSWIdx)
    Write-Host "  [OK] 已从 dist/index.html 移除 SW 注册标签并注入 SW-killer" -ForegroundColor Green
}

# 处理 dist/sw.js：替换为自毁型 SW
$distSwPath = Join-Path $distDir "sw.js"
if (Test-Path $distSwPath) {
    $utf8NoBomSwFile = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($distSwPath, $swSelfDestruct, $utf8NoBomSwFile)
    Write-Host "  [OK] 已替换 dist/sw.js 为自毁型 SW" -ForegroundColor Green
}

# 处理 dist/registerSW.js：替换为空操作（避免文件缺失报错）
$distRegisterSwPath = Join-Path $distDir "registerSW.js"
if (Test-Path $distRegisterSwPath) {
    $utf8NoBomRegSw = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($distRegisterSwPath, "// Roche: SW registration disabled", $utf8NoBomRegSw)
    Write-Host "  [OK] 已禁用 dist/registerSW.js" -ForegroundColor Gray
}
Write-Host ""

# ============================================================
# 第 3.5 步：同步 Capacitor 原生插件
# ============================================================
Write-Host "[3.5/6] 同步 Capacitor 原生插件..." -ForegroundColor Yellow

npx cap sync android
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [警告] cap sync 出现警告，继续尝试..." -ForegroundColor Yellow
} else {
    Write-Host "  [OK] Capacitor 插件同步完成" -ForegroundColor Green
}
Write-Host ""

# ============================================================
# 第 3.8 步：复制全部 4 个模板到用户项目（prepare:android 前复制，确保脚本读到正确模板）
# ============================================================
Write-Host "[3.8/6] 复制保活模板到用户项目..." -ForegroundColor Yellow

$builtinTemplateDir = Join-Path $ScriptDir "templates\android-background-audio"
$projectTemplateDir = Join-Path $ProjectDir "templates\android-background-audio"

if (-not (Test-Path $projectTemplateDir)) {
    New-Item -ItemType Directory -Force -Path $projectTemplateDir | Out-Null
}

$allTemplates = @(
    "BackgroundAudioService.java.template",
    "BackgroundAudioPlugin.java.template",
    "MainActivity.java.template",
    "RocheFirebaseMessagingService.java.template"
)

foreach ($tplName in $allTemplates) {
    $srcTpl = Join-Path $builtinTemplateDir $tplName
    $dstTpl = Join-Path $projectTemplateDir $tplName
    if (Test-Path $srcTpl) {
        Copy-Item $srcTpl $dstTpl -Force
        Write-Host "  [OK] 已复制 $tplName" -ForegroundColor Gray
    } else {
        Write-Host "  [警告] 缺少模板: $tplName (源: $srcTpl)" -ForegroundColor Yellow
    }
}
Write-Host ""

# ============================================================
# 第 4 步：执行准备脚本
# ============================================================
Write-Host "[4/6] 执行准备脚本..." -ForegroundColor Yellow

npm run prepare:android
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [警告] 准备脚本执行出现警告，继续尝试..." -ForegroundColor Yellow
} else {
    Write-Host "  [OK] 准备脚本执行完成" -ForegroundColor Green
}

# 4.1 直接覆盖全部 4 个 Java 文件（确保保活修复 + 全屏沉浸式 + registerPlugin + 推送通知）
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$javaDir = Join-Path $ProjectDir "android\app\src\main\java\com\roche\app"

# 确保目录存在
if (-not (Test-Path $javaDir)) {
    New-Item -ItemType Directory -Force -Path $javaDir | Out-Null
}

# 定义 4 个模板 -> Java 文件的映射
$javaOverwrites = @(
    @{ Template = "BackgroundAudioService.java.template"; JavaFile = "BackgroundAudioService.java"; Desc = "保活前台服务" },
    @{ Template = "BackgroundAudioPlugin.java.template"; JavaFile = "BackgroundAudioPlugin.java"; Desc = "Capacitor保活插件" },
    @{ Template = "MainActivity.java.template"; JavaFile = "MainActivity.java"; Desc = "全屏沉浸式+registerPlugin" },
    @{ Template = "RocheFirebaseMessagingService.java.template"; JavaFile = "RocheFirebaseMessagingService.java"; Desc = "推送通知服务" }
)

foreach ($item in $javaOverwrites) {
    $tplPath = Join-Path $builtinTemplateDir $item.Template
    $javaPath = Join-Path $javaDir $item.JavaFile
    if (Test-Path $tplPath) {
        $content = (Get-Content $tplPath -Raw -Encoding UTF8) -replace '__PACKAGE__', 'com.roche.app'
        [System.IO.File]::WriteAllText($javaPath, $content, $utf8NoBom)
        Write-Host "  [OK] 已覆盖 $($item.JavaFile)（$($item.Desc)）" -ForegroundColor Green
    } else {
        Write-Host "  [警告] 缺少模板: $($item.Template)" -ForegroundColor Yellow
    }
}

# 4.1.2 强制修复 AndroidManifest.xml（确保蓝牙、麦克风等权限存在）
$manifestPath = Join-Path $ProjectDir "android\app\src\main\AndroidManifest.xml"
if (Test-Path $manifestPath) {
    $manifestContent = Get-Content $manifestPath -Raw -Encoding UTF8
    $manifestChanged = $false

    # 需要确保的权限列表
    $requiredPermissions = @(
        'android.permission.WAKE_LOCK',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.VIBRATE',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
        'android.permission.BLUETOOTH',
        'android.permission.BLUETOOTH_ADMIN',
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.RECORD_AUDIO',
        'android.permission.MODIFY_AUDIO_SETTINGS'
    )

    foreach ($perm in $requiredPermissions) {
        $permTag = "<uses-permission android:name=`"$perm`" />"
        $permTagAlt = "<uses-permission android:name=`"$perm`"/>"
        if (-not ($manifestContent -match [regex]::Escape($perm))) {
            # 在 </manifest> 前插入权限
            $insertLine = "    <uses-permission android:name=`"$perm`" />`n"
            $manifestContent = $manifestContent -replace '</manifest>', "$insertLine</manifest>"
            $manifestChanged = $true
            Write-Host "  [修复] 添加权限: $perm" -ForegroundColor Yellow
        }
    }

    if ($manifestChanged) {
        $manifestUtf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($manifestPath, $manifestContent, $manifestUtf8)
        Write-Host "  [OK] AndroidManifest.xml 已修复（蓝牙+麦克风权限）" -ForegroundColor Green
    } else {
        Write-Host "  [OK] AndroidManifest.xml 权限完整" -ForegroundColor Gray
    }

    # 4.1.3 性能优化：largeHeap + hardwareAccelerated（解决大存储卡顿/闪退）
    $manifestContent = Get-Content $manifestPath -Raw -Encoding UTF8
    $perfChanged = $false

    # 添加 largeHeap="true"（让应用获得 512MB+ 堆内存，默认只有 192-256MB）
    if ($manifestContent -match '<application[^>]*>') {
        $appTagMatch = [regex]::Match($manifestContent, '<application([^>]*)>')
        $appTagAttrs = $appTagMatch.Groups[1].Value

        # largeHeap：检查是否已存在（任何值），避免重复属性
        if ($appTagAttrs -match 'largeHeap\s*=\s*"true"') {
            # 已经是 true，跳过
        } elseif ($appTagAttrs -match 'android:largeHeap\s*=\s*"[^"]*"') {
            # 存在但不是 true（如 false），替换为 true
            $manifestContent = $manifestContent -replace 'android:largeHeap\s*=\s*"[^"]*"', 'android:largeHeap="true"'
            $perfChanged = $true
            Write-Host "  [OK] largeHeap 已改为 true（大内存模式）" -ForegroundColor Green
        } else {
            # 不存在，添加
            $newAttrs = $appTagAttrs + ' android:largeHeap="true"'
            $manifestContent = $manifestContent.Replace($appTagMatch.Value, "<application$newAttrs>")
            $perfChanged = $true
            Write-Host "  [OK] 已启用 largeHeap（大内存模式，解决大存储卡顿）" -ForegroundColor Green
        }

        # 重新读取 application 标签属性（可能已被修改）
        $appTagMatch2 = [regex]::Match($manifestContent, '<application([^>]*)>')
        $appTagAttrs2 = $appTagMatch2.Groups[1].Value

        # hardwareAccelerated：同样检查避免重复
        if ($appTagAttrs2 -match 'hardwareAccelerated\s*=\s*"true"') {
            # 已经是 true，跳过
        } elseif ($appTagAttrs2 -match 'android:hardwareAccelerated\s*=\s*"[^"]*"') {
            # 存在但不是 true，替换为 true
            $manifestContent = $manifestContent -replace 'android:hardwareAccelerated\s*=\s*"[^"]*"', 'android:hardwareAccelerated="true"'
            $perfChanged = $true
            Write-Host "  [OK] hardwareAccelerated 已改为 true" -ForegroundColor Green
        } else {
            # 不存在，添加
            $newAttrs2 = $appTagAttrs2 + ' android:hardwareAccelerated="true"'
            $manifestContent = $manifestContent.Replace($appTagMatch2.Value, "<application$newAttrs2>")
            $perfChanged = $true
            Write-Host "  [OK] 已启用 hardwareAccelerated（硬件加速）" -ForegroundColor Green
        }
    }

    if ($perfChanged) {
        $manifestUtf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($manifestPath, $manifestContent, $manifestUtf8)
    }
}

# 4.1.5 备份注入 native-audio-bridge.js 到 android assets（内联模式，防止 cap sync 未复制成功）
$androidAssetsDir = Join-Path $ProjectDir "android\app\src\main\assets\public"
$androidAssetsBridge = Join-Path $androidAssetsDir "native-audio-bridge.js"
$androidAssetsIndex = Join-Path $androidAssetsDir "index.html"

if ((Test-Path $sourceBridge) -and (Test-Path $androidAssetsDir)) {
    # 备份 bridge 文件
    Copy-Item $sourceBridge $androidAssetsBridge -Force
    Write-Host "  [OK] 已备份 native-audio-bridge.js 到 android assets" -ForegroundColor Gray

    # 内联注入到 android assets/index.html
    if (Test-Path $androidAssetsIndex) {
        $aaIndexContent = Get-Content $androidAssetsIndex -Raw -Encoding UTF8
        $aaBridgeContent = Get-Content $sourceBridge -Raw -Encoding UTF8
        $aaInlineScript = "<script>$bridgeMarker`n$aaBridgeContent`n</script>"

        # 移除已有的 bridge 块和旧 src 引用
        $aaIndexContent = [regex]::Replace($aaIndexContent, $pattern, '')
        $aaIndexContent = $aaIndexContent -replace '<script src="\./native-audio-bridge\.js"></script>\s*', ''

        if ($aaIndexContent -match '</head>') {
            $aaIndexContent = $aaIndexContent -replace '</head>', "$aaInlineScript`n</head>"
        } elseif ($aaIndexContent -match '</body>') {
            $aaIndexContent = $aaIndexContent -replace '</body>', "$aaInlineScript`n</body>"
        }

        $utf8NoBomAA = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($androidAssetsIndex, $aaIndexContent, $utf8NoBomAA)
        Write-Host "  [OK] 已内联注入 bridge 到 android assets/index.html" -ForegroundColor Green
    }
}

# 4.1.6 备份注入 roche-optimizer.js 到 android assets（性能优化，防止大存储 OOM）
$androidAssetsOptimizer = Join-Path $androidAssetsDir "roche-optimizer.js"

if ((Test-Path $sourceOptimizer) -and (Test-Path $androidAssetsDir)) {
    # 备份 optimizer 文件
    Copy-Item $sourceOptimizer $androidAssetsOptimizer -Force
    Write-Host "  [OK] 已备份 roche-optimizer.js 到 android assets" -ForegroundColor Gray

    # 内联注入到 android assets/index.html
    if (Test-Path $androidAssetsIndex) {
        $aaIndexContent2 = Get-Content $androidAssetsIndex -Raw -Encoding UTF8
        $aaOptContent = Get-Content $sourceOptimizer -Raw -Encoding UTF8
        $aaInlineOpt = "<script>$optimizerMarker`n$aaOptContent`n</script>"

        # 移除已有的 optimizer 块和旧 src 引用
        $aaIndexContent2 = [regex]::Replace($aaIndexContent2, $patternOpt, '')
        $aaIndexContent2 = $aaIndexContent2 -replace '<script src="\./roche-optimizer\.js"></script>\s*', ''
        # 移除 roche-profiler.js 引用（调试工具，不应出现在生产环境）
        $aaIndexContent2 = $aaIndexContent2 -replace '<script src="\./roche-profiler\.js"></script>\s*', ''

        # 注入到 <meta charset> 之后（避免编码问题），在其他脚本之前
        if ($aaIndexContent2 -match '<meta\s+charset[^>]*>') {
            $aaIndexContent2 = [regex]::Replace($aaIndexContent2, '<meta\s+charset[^>]*>', "`$0`n$aaInlineOpt", 1)
        } elseif ($aaIndexContent2 -match '<head[^>]*>') {
            $aaIndexContent2 = [regex]::Replace($aaIndexContent2, '<head[^>]*>', "`$0`n$aaInlineOpt", 1)
        } elseif ($aaIndexContent2 -match '</head>') {
            $aaIndexContent2 = $aaIndexContent2 -replace '</head>', "$aaInlineOpt`n</head>"
        }

        $utf8NoBomAA2 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($androidAssetsIndex, $aaIndexContent2, $utf8NoBomAA2)
        Write-Host "  [OK] 已内联注入 roche-optimizer.js 到 android assets/index.html" -ForegroundColor Green
    }
}

# 4.1.7 注入 roche-conv-sync-fix.js 到 android assets（修复新建角色+思维链崩溃）
Write-Host "  [信息] 注入对话同步修复脚本到 android assets..." -ForegroundColor Gray

if ((Test-Path $sourceConvSync) -and (Test-Path $androidAssetsDir)) {
    $androidAssetsConvSync = Join-Path $androidAssetsDir "roche-conv-sync-fix.js"
    Copy-Item $sourceConvSync $androidAssetsConvSync -Force
    Write-Host "  [OK] 已复制 roche-conv-sync-fix.js 到 android assets" -ForegroundColor Gray

    if (Test-Path $androidAssetsIndex) {
        $aaIndexContent3 = Get-Content $androidAssetsIndex -Raw -Encoding UTF8
        $convSyncTag = '<script src="./roche-conv-sync-fix.js"></script>'

        # 移除已有的引用（避免重复）
        $aaIndexContent3 = $aaIndexContent3 -replace '<script src="\./roche-conv-sync-fix\.js"></script>\s*', ''

        # 在主程序 script 标签之前插入
        if ($aaIndexContent3 -match '<script\s+type="module"\s+crossorigin\s+src="\./assets/index-[^"]+\.js"></script>') {
            $aaIndexContent3 = [regex]::Replace($aaIndexContent3, '<script\s+type="module"\s+crossorigin\s+src="\./assets/index-[^"]+\.js"></script>', "$convSyncTag`n  `$0", 1)
            $utf8NoBomAA3 = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($androidAssetsIndex, $aaIndexContent3, $utf8NoBomAA3)
            Write-Host "  [OK] 已注入 roche-conv-sync-fix.js 到 android assets/index.html" -ForegroundColor Green
        } else {
            Write-Host "  [警告] 未找到主程序 script 标签，跳过注入" -ForegroundColor Yellow
        }
    }
} else {
    if (-not (Test-Path $sourceConvSync)) { Write-Host "  [跳过] 未找到 roche-conv-sync-fix.js 源文件" -ForegroundColor Gray }
}

# 4.1.8 禁用 android assets 中的 PWA Service Worker（与 dist 同步处理，防止覆盖安装后加载旧版）
# cap sync 会把 dist 复制到 android/app/src/main/assets/public，但前面的 dist 修改在 cap sync 之前，
# 所以 cap sync 后 android assets 应该已经包含 SW-killer。这里做备份确保（防止 cap sync 未完全覆盖）。
Write-Host "  [信息] 禁用 android assets 中的 PWA Service Worker..." -ForegroundColor Gray

if (Test-Path $androidAssetsIndex) {
    $aaSwIndexContent = Get-Content $androidAssetsIndex -Raw -Encoding UTF8

    # 1. 移除 registerSW.js 注册标签
    $aaSwIndexContent = $aaSwIndexContent -replace '<script id="vite-plugin-pwa:register-sw"[^>]*>\s*</script>\s*', ''
    $aaSwIndexContent = $aaSwIndexContent -replace '<script[^>]*src="[^"]*registerSW\.js"[^>]*>\s*</script>\s*', ''

    # 2. 移除已有的 SW-killer 块（避免重复注入）
    $aaSwIndexContent = [regex]::Replace($aaSwIndexContent, '(?s)<script id="roche-sw-killer">/\* ROCHE_SW_KILLER_INLINE \*/.*?</script>\s*', '')

    # 3. 注入 SW-killer 到 <meta charset> 之后
    if ($aaSwIndexContent -match '<meta\s+charset[^>]*>') {
        $aaSwIndexContent = [regex]::Replace($aaSwIndexContent, '<meta\s+charset[^>]*>', "`$0`n$swKillerInline", 1)
    } elseif ($aaSwIndexContent -match '<head[^>]*>') {
        $aaSwIndexContent = [regex]::Replace($aaSwIndexContent, '<head[^>]*>', "`$0`n$swKillerInline", 1)
    } elseif ($aaSwIndexContent -match '</head>') {
        $aaSwIndexContent = $aaSwIndexContent -replace '</head>', "$swKillerInline`n</head>"
    }

    $utf8NoBomAaSwIdx = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($androidAssetsIndex, $aaSwIndexContent, $utf8NoBomAaSwIdx)
    Write-Host "  [OK] 已从 android assets/index.html 移除 SW 注册标签并注入 SW-killer" -ForegroundColor Green
}

# 处理 android assets/sw.js
$androidAssetsSwPath = Join-Path $androidAssetsDir "sw.js"
if (Test-Path $androidAssetsSwPath) {
    $utf8NoBomAaSw = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($androidAssetsSwPath, $swSelfDestruct, $utf8NoBomAaSw)
    Write-Host "  [OK] 已替换 android assets/sw.js 为自毁型 SW" -ForegroundColor Green
}

# 处理 android assets/registerSW.js
$androidAssetsRegSwPath = Join-Path $androidAssetsDir "registerSW.js"
if (Test-Path $androidAssetsRegSwPath) {
    $utf8NoBomAaRegSw = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($androidAssetsRegSwPath, "// Roche: SW registration disabled", $utf8NoBomAaRegSw)
    Write-Host "  [OK] 已禁用 android assets/registerSW.js" -ForegroundColor Gray
}

# 4.2 再次确保 res/raw/silence.wav 存在
$rawDir2 = Join-Path $ProjectDir "android\app\src\main\res\raw"
$silenceWav2 = Join-Path $rawDir2 "silence.wav"
$sourceSilence2 = Join-Path $ScriptDir "keepalive-plugin\silence.wav"

if (-not (Test-Path $silenceWav2) -and (Test-Path $sourceSilence2)) {
    if (-not (Test-Path $rawDir2)) {
        New-Item -ItemType Directory -Force -Path $rawDir2 | Out-Null
    }
    Copy-Item $sourceSilence2 -Destination $silenceWav2 -Force
    Write-Host "  [OK] 已补充 silence.wav 到 res/raw" -ForegroundColor Green
}

Write-Host ""

# ============================================================
# 第 4.3 步：配置 Gradle 构建环境
# ============================================================
Write-Host "[4.3/6] 配置 Gradle 构建环境..." -ForegroundColor Yellow

$androidProjectDir = Join-Path $ProjectDir "android"

# 写入 local.properties
$localPropsPath = Join-Path $androidProjectDir "local.properties"
if ($androidHome) {
    $sdkDirEscaped = $androidHome -replace '\\', '\\'
    $localPropsContent = "sdk.dir=$sdkDirEscaped`n"
    # 必须用 UTF-8 编码，ASCII 会把中文路径变成 ???? 导致 Gradle 找不到 SDK
    [System.IO.File]::WriteAllText($localPropsPath, $localPropsContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  [OK] local.properties: sdk.dir=$androidHome" -ForegroundColor Green
} else {
    Write-Host "  [警告] Android SDK 未找到，跳过 local.properties" -ForegroundColor Yellow
}

# 修复 gradle.properties
$gradlePropsPath = Join-Path $androidProjectDir "gradle.properties"
$gradlePropsContent = @"
# Project-wide Gradle settings.
org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
android.overridePathCheck=true
kotlin.compiler.execution.strategy=in-process
android.builder.sdkDownload=false
"@
[System.IO.File]::WriteAllText($gradlePropsPath, $gradlePropsContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] gradle.properties 已配置" -ForegroundColor Green

# 4.3.1 修复 Gradle Wrapper 下载源（国内访问 services.gradle.org 超时）
$gradleWrapperProps = Join-Path $androidProjectDir "gradle\wrapper\gradle-wrapper.properties"
if (Test-Path $gradleWrapperProps) {
    $wrapperContent = Get-Content $gradleWrapperProps -Raw -Encoding UTF8
    $wrapperChanged = $false
    # 替换为腾讯云镜像（国内速度快且稳定）
    if ($wrapperContent -match 'services\.gradle\.org/distributions') {
        $wrapperContent = $wrapperContent -replace 'services\.gradle\.org/distributions', 'mirrors.cloud.tencent.com/gradle'
        $wrapperChanged = $true
    }
    # 同时清理可能损坏的 dists 缓存（zip END header not found 错误）
    if ($wrapperChanged) {
        $utf8NoBomWrap = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($gradleWrapperProps, $wrapperContent, $utf8NoBomWrap)

        # 验证替换是否真的生效（读取文件确认）
        $verifyContent = Get-Content $gradleWrapperProps -Raw -Encoding UTF8
        if ($verifyContent -match 'services\.gradle\.org') {
            Write-Host "  [警告] Gradle 镜像替换可能失败，仍检测到官方源！" -ForegroundColor Yellow
            # 强制替换：直接操作字符串
            $verifyContent = $verifyContent.Replace('services.gradle.org/distributions', 'mirrors.cloud.tencent.com/gradle')
            [System.IO.File]::WriteAllText($gradleWrapperProps, $verifyContent, $utf8NoBomWrap)
            $verifyContent2 = Get-Content $gradleWrapperProps -Raw -Encoding UTF8
            if ($verifyContent2 -match 'services\.gradle\.org') {
                Write-Host "  [失败] Gradle 镜像替换仍失败！请手动修改: $gradleWrapperProps" -ForegroundColor Red
            } else {
                Write-Host "  [OK] Gradle 下载源已强制替换为腾讯云镜像（验证通过）" -ForegroundColor Green
            }
        } else {
            Write-Host "  [OK] Gradle 下载源已替换为腾讯云镜像（验证通过）" -ForegroundColor Green
        }

        # 清理损坏的 gradle dists 缓存
        $gradleUserHome = $env:GRADLE_USER_HOME
        if (-not $gradleUserHome) { $gradleUserHome = Join-Path $env:USERPROFILE ".gradle" }
        $distsDir = Join-Path $gradleUserHome "wrapper\dists"
        if (Test-Path $distsDir) {
            try {
                Get-ChildItem $distsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                    $lockFile = Join-Path $_.FullName "gradle-8.14.3-all.zip.lck"
                    $zipFile = Join-Path $_.FullName "gradle-8.14.3-all.zip"
                    # 如果 zip 不存在或小于 1MB（损坏），清理整个目录
                    $needClean = $false
                    if (Test-Path $zipFile) {
                        $zipSize = (Get-Item $zipFile).Length
                        if ($zipSize -lt 1000000) { $needClean = $true }
                    } else {
                        $needClean = $true
                    }
                    if ($needClean) {
                        Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                        Write-Host "  [清理] 已删除损坏的 Gradle 缓存: $($_.Name)" -ForegroundColor Gray
                    }
                }
            } catch {}
        }
    }
}

# 4.3.2 修复 build.gradle 仓库为国内镜像 + 锁定 AGP 稳定版本
$buildGradlePath = Join-Path $androidProjectDir "build.gradle"
if (Test-Path $buildGradlePath) {
    $bgContent = Get-Content $buildGradlePath -Raw -Encoding UTF8
    $bgChanged = $false

    # 锁定 AGP 到 8.9.1（新版 AndroidX 依赖要求 AGP 8.9+）
    if ($bgContent -match 'com\.android\.tools\.build:gradle:\d+\.\d+\.\d+') {
        $bgContent = $bgContent -replace 'com\.android\.tools\.build:gradle:\d+\.\d+\.\d+', 'com.android.tools.build:gradle:8.9.1'
        $bgChanged = $true
        Write-Host "  [OK] AGP 已锁定为 8.9.1（新版 AndroidX 兼容）" -ForegroundColor Green
    }

    # 检查是否已注入镜像标记
    if (-not ($bgContent -match 'ROCHE_CN_MIRROR')) {
        # 在 buildscript.repositories 和 allprojects.repositories 里都注入镜像
        if ($bgContent -match 'repositories\s*\{') {
            $bgContent = $bgContent -replace 'repositories\s*\{', "repositories {`n        maven { url 'https://maven.aliyun.com/repository/google' }`n        maven { url 'https://maven.aliyun.com/repository/public' }`n        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }"
            $bgChanged = $true
        }
    }

    if ($bgChanged) {
        $utf8NoBomBg = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($buildGradlePath, $bgContent, $utf8NoBomBg)
        Write-Host "  [OK] build.gradle 已配置（镜像+AGP锁定）" -ForegroundColor Green
    }
}

# 4.3.2.1 锁定 compileSdk/targetSdk 为 36（新版 AndroidX 依赖要求 SDK 36）
$variablesGradlePath = Join-Path $androidProjectDir "variables.gradle"
if (Test-Path $variablesGradlePath) {
    $vgContent = Get-Content $variablesGradlePath -Raw -Encoding UTF8
    $vgChanged = $false
    if ($vgContent -match 'compileSdkVersion\s*=\s*\d+') {
        $vgContent = $vgContent -replace 'compileSdkVersion\s*=\s*\d+', 'compileSdkVersion = 36'
        $vgChanged = $true
    }
    if ($vgContent -match 'targetSdkVersion\s*=\s*\d+') {
        $vgContent = $vgContent -replace 'targetSdkVersion\s*=\s*\d+', 'targetSdkVersion = 36'
        $vgChanged = $true
    }
    # 强制 buildToolsVersion 为 36.0.0（避免找不到 34.0.0）
    if ($vgContent -match 'buildToolsVersion') {
        $vgContent = $vgContent -replace "buildToolsVersion\s*=\s*'[^']*'", "buildToolsVersion = '36.0.0'"
    } else {
        $vgContent = $vgContent -replace "(ext\s*\{)", "`$1`n    buildToolsVersion = '36.0.0'"
    }
    $vgChanged = $true
    if ($vgChanged) {
        $utf8NoBomVg = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($variablesGradlePath, $vgContent, $utf8NoBomVg)
        Write-Host "  [OK] compileSdk/targetSdk 锁定为 36 + buildTools 36.0.0（新版 AndroidX 兼容）" -ForegroundColor Green
    }
}

# 4.3.3 修复 app/build.gradle 仓库（子项目）
$appBuildGradlePath = Join-Path $androidProjectDir "app\build.gradle"
if (Test-Path $appBuildGradlePath) {
    $abgContent = Get-Content $appBuildGradlePath -Raw -Encoding UTF8
    if (($abgContent -match 'repositories\s*\{') -and -not ($abgContent -match 'ROCHE_CN_MIRROR')) {
        $abgContent = $abgContent -replace 'repositories\s*\{', "repositories {`n        maven { url 'https://maven.aliyun.com/repository/google' }`n        maven { url 'https://maven.aliyun.com/repository/public' }`n        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }"
        $utf8NoBomAbg = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($appBuildGradlePath, $abgContent, $utf8NoBomAbg)
        Write-Host "  [OK] app/build.gradle 已注入阿里云镜像" -ForegroundColor Green
    }
}

# 4.3.4 配置 foojay-resolver（自动下载 JDK 21，capacitor-filesystem 需要）
$settingsGradlePath = Join-Path $androidProjectDir "settings.gradle"
if (Test-Path $settingsGradlePath) {
    $sgContent = Get-Content $settingsGradlePath -Raw -Encoding UTF8
    if (-not ($sgContent -match 'foojay-resolver')) {
        # 提取所有 include 语句
        $includeLines = ($sgContent -split "`n" | Where-Object { $_ -match '^\s*include' }) -join "`n"
        # 重写 settings.gradle：pluginManagement + plugins + includes + capacitor 引用
        $newSettings = @"
pluginManagement {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
        maven { url 'https://maven.aliyun.com/repository/public' }
        gradlePluginPortal()
        google()
    }
}
plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '0.8.0'
}

$includeLines
apply from: 'capacitor.settings.gradle'
"@
        $utf8NoBomSg = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($settingsGradlePath, $newSettings, $utf8NoBomSg)
        Write-Host "  [OK] 已配置 foojay-resolver（自动下载 JDK 21）" -ForegroundColor Green
    } else {
        Write-Host "  [OK] settings.gradle 已有 foojay-resolver" -ForegroundColor Gray
    }
}

# 4.3.5 确保 gradle.properties 允许自动下载 toolchain
$gpPath = Join-Path $androidProjectDir "gradle.properties"
if (Test-Path $gpPath) {
    $gpContent = Get-Content $gpPath -Raw -Encoding UTF8
    if (-not ($gpContent -match 'org.gradle.java.installations.auto-download')) {
        $gpContent = $gpContent.TrimEnd() + "`norg.gradle.java.installations.auto-download=true`n"
        $utf8NoBomGp = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($gpPath, $gpContent, $utf8NoBomGp)
        Write-Host "  [OK] 已启用 Gradle toolchain 自动下载" -ForegroundColor Green
    }
}

Write-Host ""

# ============================================================
# 第 5 步：构建 APK
# ============================================================
Write-Host "[5/6] 构建 APK（可能需要几分钟）..." -ForegroundColor Yellow

Set-Location $androidProjectDir

$gradlew = Join-Path (Get-Location) "gradlew.bat"
if (-not (Test-Path $gradlew)) {
    Write-Host "  [失败] 未找到 gradlew.bat" -ForegroundColor Red
    throw "gradlew.bat not found"
}

# 使用 --no-daemon 避免 aapt2 daemon 缓存损坏导致构建失败
# 每次都用全新进程，确保环境干净
& $gradlew assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [失败] APK 构建失败！" -ForegroundColor Red
    throw "Gradle build failed"
}

Write-Host ""

# ============================================================
# 第 6 步：输出结果
# ============================================================
Write-Host "[6/6] 打包完成！" -ForegroundColor Green

$apkPath = Join-Path $ProjectDir "android\app\build\outputs\apk\debug\app-debug.apk"
$finalApk = Join-Path $ScriptDir "roche-app-debug.apk"
if (Test-Path $apkPath) {
    Copy-Item $apkPath $finalApk -Force
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  APK 打包成功！(Debug 测试版)" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "文件位置:" -ForegroundColor Cyan
Write-Host "  $finalApk" -ForegroundColor White
Write-Host ""

if (Test-Path $finalApk) {
    $size = [math]::Round((Get-Item $finalApk).Length / 1MB, 2)
    Write-Host "文件大小: $size MB" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "安装方法:" -ForegroundColor Cyan
Write-Host "  1. 将 roche-app-debug.apk 传到手机安装" -ForegroundColor White
Write-Host "  2. 或用命令: adb install `"$finalApk`"" -ForegroundColor White
Write-Host ""

# 打开脚本所在文件夹
try {
    Start-Process explorer.exe $ScriptDir
    Write-Host "[信息] 已打开文件夹" -ForegroundColor Gray
} catch {}

} catch {
    # ============================================================
    # 错误处理：显示错误信息，不闪退
    # ============================================================
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  打包失败！" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误信息: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "请根据上面的提示修复问题后重试。" -ForegroundColor Yellow
    Write-Host ""
}

# ============================================================
# 最后暂停，防止窗口闪退（无论成功或失败都暂停）
# ============================================================
Write-Host "========================================" -ForegroundColor Gray
Write-Host "按任意键关闭窗口..." -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Gray
try {
    [System.Console]::ReadKey($true) | Out-Null
} catch {
    # 如果 ReadKey 不可用（非交互模式），用 Read-Host
    Read-Host "按回车关闭窗口"
}
