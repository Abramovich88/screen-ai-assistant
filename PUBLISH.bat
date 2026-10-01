@echo off
chcp 65001 >nul
title Publish to GitHub
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1"
