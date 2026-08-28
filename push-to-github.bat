@echo off
setlocal enabledelayedexpansion
title Push Chinese Checkers to GitHub
cd /d "%~dp0"

set REPO_URL=https://github.com/PJH-Eric/chinese-checkers.git

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found. Install Git for Windows: https://git-scm.com/
  pause
  exit /b 1
)

echo Repository : %REPO_URL%
echo Folder     : %CD%
echo.

rem --- clear a stale lock left by an interrupted git run -------
if exist ".git\index.lock" (
  echo Removing stale .git\index.lock ...
  del /q ".git\index.lock"
)

if not exist ".git" (
  echo Initializing repository...
  git init
)

rem --- git identity -------------------------------------------
for /f "delims=" %%i in ('git config user.email 2^>nul') do set GITMAIL=%%i
if "!GITMAIL!"=="" (
  git config user.email "ericpan@chase.com.tw"
  git config user.name "PJH-Eric"
  echo Set local git identity to PJH-Eric ^<ericpan@chase.com.tw^>
)

rem --- branch must be main ------------------------------------
git branch -M main

rem --- origin must point at the repo --------------------------
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin %REPO_URL%
) else (
  git remote set-url origin %REPO_URL%
)

rem --- first run: build on top of the remote initial commit ----
rem     so the push is a fast-forward and needs no --force
git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 (
  echo No local commits yet. Fetching remote history...
  git fetch origin main
  if not errorlevel 1 (
    git reset --soft FETCH_HEAD
    echo Based on remote commit. Your files will replace the placeholder
    echo README.md and .gitignore that GitHub created.
  ) else (
    echo Remote has no main branch yet. Starting fresh.
  )
)

echo.
echo Staging files...
git add -A
git commit -m "Chinese Checkers: online multiplayer + offline single-player web game"
if errorlevel 1 (
  echo Nothing new to commit. Continuing...
)

echo.
echo Pushing to GitHub...
git push -u origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Push failed. Common causes:
  echo   1. Not authenticated. Git for Windows should open a browser login.
  echo      Otherwise use a Personal Access Token as the password
  echo      ^(https://github.com/settings/tokens , scope: repo^).
  echo   2. Company proxy blocking github.com. Configure it:
  echo        git config --global http.proxy http://user:pass@proxy:port
  echo        git config --global https.proxy http://user:pass@proxy:port
  echo   3. Remote moved ahead. Then run:
  echo        git pull --rebase origin main
  echo        git push origin main
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Pushed successfully.
echo.
echo   Next, on github.com/PJH-Eric/chinese-checkers :
echo.
echo   1. Settings ^> Pages ^> Source: choose "GitHub Actions"
echo      The offline single-player build then deploys to
echo      https://pjh-eric.github.io/chinese-checkers/
echo.
echo   2. Optional - online multiplayer on Render:
echo      render.com ^> New ^> Blueprint ^> pick this repo ^> Apply
echo      Then Settings ^> Secrets and variables ^> Actions ^> Variables
echo      add ONLINE_URL = your Render URL.
echo.
echo   Details in DEPLOY.md
echo ============================================================
echo.
pause
