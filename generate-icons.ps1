Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot "icons"
if (-not (Test-Path $iconDir)) {
    New-Item -ItemType Directory -Path $iconDir | Out-Null
}

foreach ($size in @(16, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::FromArgb(24, 26, 36))

    $scale = $size / 128.0

    # Document body (rounded-ish rectangle)
    $docBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(129, 140, 248))
    $docX = [int](24 * $scale)
    $docY = [int](12 * $scale)
    $docW = [int](65 * $scale)
    $docH = [int](96 * $scale)
    $g.FillRectangle($docBrush, $docX, $docY, $docW, $docH)

    # Page fold triangle
    $foldBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 110, 220))
    $foldSize = [int](18 * $scale)
    $foldPoints = @(
        (New-Object System.Drawing.Point(($docX + $docW - $foldSize), $docY)),
        (New-Object System.Drawing.Point(($docX + $docW), $docY)),
        (New-Object System.Drawing.Point(($docX + $docW), ($docY + $foldSize)))
    )
    $g.FillPolygon($foldBrush, $foldPoints)

    # Text lines on page
    $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 230, 235, 255))
    $lineH = [math]::Max(1, [int](5 * $scale))
    $lineX = [int](34 * $scale)
    $lineGap = [int](16 * $scale)
    for ($i = 0; $i -lt 3; $i++) {
        $lineY = [int](38 * $scale) + ($i * $lineGap)
        $lineW = if ($i -eq 2) { [int](30 * $scale) } else { [int](42 * $scale) }
        $g.FillRectangle($lineBrush, $lineX, $lineY, $lineW, $lineH)
    }

    # Export arrow
    $arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 231, 183), [math]::Max(2, [int](6 * $scale)))
    $arrowPen.EndCap = 'ArrowAnchor'
    $arrowPen.StartCap = 'Round'
    $ax1 = [int](60 * $scale)
    $ay  = [int](90 * $scale)
    $ax2 = [int](115 * $scale)
    $g.DrawLine($arrowPen, $ax1, $ay, $ax2, $ay)

    $g.Dispose()
    $outPath = Join-Path $iconDir "icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created $outPath"
}
