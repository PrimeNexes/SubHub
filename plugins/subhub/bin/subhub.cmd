@echo off
rem SubHub launcher (Windows). The engine is subhub.mjs next to this file; it needs Node.js 18+.
where node >nul 2>nul || (echo SubHub needs Node.js 18 or newer: https://nodejs.org 1>&2 & exit /b 127)
node "%~dp0subhub.mjs" %*
