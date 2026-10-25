param(
    [switch]$LocalTest,
    [string]$Sdk = "$env:LOCALAPPDATA/Android/Sdk",
    [string]$Java = 'C:/Program Files/Android/Android Studio/jbr'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$build = Join-Path $env:TEMP ('space-map-android/' + [guid]::NewGuid().ToString('N'))
$signing = Join-Path $projectRoot 'tmp/android-signing'
$artifacts = Join-Path $projectRoot 'artifacts'
$buildTools = Join-Path $Sdk 'build-tools/36.1.0'
$androidJar = Join-Path $Sdk 'platforms/android-36.1/android.jar'
function Run([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed: $LASTEXITCODE" }
}
foreach($directory in @($build, "$build/gen", "$build/classes", "$build/dex", $signing, $artifacts)) { New-Item -ItemType Directory -Force $directory | Out-Null }
if (!(Test-Path $androidJar)) { throw 'Install Android SDK platform 36.1 and build-tools 36.1.0, or set -Sdk.' }
$source = Join-Path $build 'main'
Copy-Item -LiteralPath (Join-Path $projectRoot 'android/app/src/main') -Destination $source -Recurse
$manifest = Get-Content "$source/AndroidManifest.xml" -Raw
$origin = 'https://vladikgolosnoi.ru'
if($LocalTest) { $origin = 'http://10.0.2.2:8012'; $manifest = $manifest.Replace('usesCleartextTraffic="false"','usesCleartextTraffic="true"') }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$build/AndroidManifest.xml", $manifest, $utf8)
[IO.File]::WriteAllText("$build/BuildConfig.java", "package ru.vladikgolosnoi.spacemap; public final class BuildConfig { public static final String ORIGIN = `"$origin`"; }", $utf8)
Run "$buildTools/aapt2.exe" @('compile','--dir',"$source/res",'-o',"$build/resources.zip")
Run "$buildTools/aapt2.exe" @('link','-o',"$build/unsigned.apk",'-I',$androidJar,'--manifest',"$build/AndroidManifest.xml",'--java',"$build/gen",'--min-sdk-version','26','--target-sdk-version','35',"$build/resources.zip")
$sources = @(Get-ChildItem "$source/java", "$build/gen" -Recurse -Filter *.java | ForEach-Object FullName) + @("$build/BuildConfig.java")
Run "$Java/bin/javac.exe" (@('-encoding','UTF-8','-source','8','-target','8','-bootclasspath',"$androidJar;$buildTools/core-lambda-stubs.jar",'-d',"$build/classes") + $sources)
Run "$Java/bin/jar.exe" @('cf',"$build/classes.jar",'-C',"$build/classes",'.')
Run "$Java/bin/java.exe" @('-cp',"$buildTools/lib/d8.jar",'com.android.tools.r8.D8','--min-api','26','--lib',$androidJar,'--output',"$build/dex", "$build/classes.jar")
Push-Location "$build/dex"
try { Run "$buildTools/aapt.exe" @('add',"$build/unsigned.apk",'classes.dex') } finally { Pop-Location }
Run "$buildTools/zipalign.exe" @('-f','4',"$build/unsigned.apk", "$build/aligned.apk")
$key = "$signing/debug.keystore"
if (!(Test-Path $key)) {
    Run "$Java/bin/keytool.exe" @('-genkeypair','-keystore',$key,'-storepass','android','-keypass','android','-alias','androiddebugkey','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=Space Map Demo,O=Hackathon,C=RU')
}
$name = if ($LocalTest) { 'space-map-local-test.apk' } else { 'space-map-demo.apk' }
$apk = Join-Path $artifacts $name
Run "$Java/bin/java.exe" @('-jar',"$buildTools/lib/apksigner.jar",'sign','--ks',$key,'--ks-key-alias','androiddebugkey','--ks-pass','pass:android','--key-pass','pass:android','--out',$apk,"$build/aligned.apk")
Run "$Java/bin/java.exe" @('-jar',"$buildTools/lib/apksigner.jar",'verify','--verbose',$apk)
Write-Output "Built demo APK: $apk"
Write-Output "Server: $origin (internet needed; no Android LiDAR support)"
