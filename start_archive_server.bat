@echo off
title MyLMS Archive Server (pywb)
echo =====================================================================
echo  SERVER ARSIP KUIS MYLMS TELKOM SCHOOLS BERJALAN (PORT 8080)
echo =====================================================================
echo.
echo Buka peramban Google Chrome dan akses URL berikut (dengan CSS penuh):
echo http://localhost:8080/mylms/https://mylms.telkomschools.sch.id/mod/quiz/attempt.php?attempt=2993340^&cmid=134638
echo.
echo Tekan tombol Ctrl+C di terminal ini jika ingin menghentikan server.
echo =====================================================================
echo.
cd /d "%~dp0pywb_data"
"C:\Users\Melvino Rafi\AppData\Local\Programs\Python\Python311\Scripts\wayback.exe"
pause
