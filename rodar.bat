@echo off
cd /d "%~dp0"
echo ================================
echo  NEXORA - Iniciando servidor...
echo ================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale o Node 22+ em https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)
if not exist nexora.db (
  echo Criando banco de dados...
  call npm run init-db
)
echo.
echo Site no ar: http://localhost:3000/
echo Admin: usuario admin / senha Admin123!
echo (Nao feche esta janela enquanto usa o site)
echo.
call npm start
pause
