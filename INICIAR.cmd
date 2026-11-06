@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Instale o Node.js 24 ou superior para iniciar o aplicativo.
 pause
 exit /b 1
)
if not exist node_modules (
 echo Execute npm ci nesta pasta antes da primeira utilizacao.
 pause
 exit /b 1
)
if not exist .next\BUILD_ID (
 call npm run build
 if errorlevel 1 (
  pause
  exit /b 1
 )
)
echo Abra http://127.0.0.1:3210 no navegador.
echo Para encerrar o aplicativo, pressione Ctrl+C nesta janela.
call npm start
pause
