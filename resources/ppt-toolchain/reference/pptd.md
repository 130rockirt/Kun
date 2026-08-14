# PPTD Format Specification

PPTD (PPT-DSL) is a YAML abstraction layer for PowerPoint presentations, used to describe, generate, and edit slides in an AI-friendly way, with lossless bidirectional conversion to and from PPTX

---

## Conventions in This Document
- Uses **TS interfaces** to describe structures, with **field tables** and **minimal YAML examples** to aid understanding
- **Default values** are annotated in TS end-of-line comments as `// default: X`. X may be a literal (`1` / `"top"` / `[0, 0]`) or a descriptive phrase (`not applied` / `not shown` / `falls back along the inheritance chain` / `auto-adapts to chart size`, etc.)
- **Constraints** are annotated in TS end-of-line comments or below the TS block as `// constraint: ...`, uniformly using interval or inequality notation (`[0, 1]` / `> 0`) or textual descriptions
---


## Focused specification chapters

- [Global conventions and shared types](pptd/global-and-shared-types.md)
- [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)
- [Charts and chart series](pptd/charts.md)
- [Examples and animations](pptd/examples-and-animations.md)

The headings below keep the original anchors stable while the full normative text lives in focused files.

## 1. Global Conventions
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Syntax
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Coordinate System and Units
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Style Priority and Default Values
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

#### 1. Text Styles Inside a Text Box
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

#### 2. Table Cell Styles
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

#### 3. Chart Styles
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Multi-File Structure
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

## 2. Shared Types
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Color
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### FontFamily
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Alignment
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### LineStyle
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Border
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

#### BorderSpec
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Shadow
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### ColorStop
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### ImageFit / ImageCrop
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

### Fill
Full content: [Global conventions and shared types](pptd/global-and-shared-types.md)

## 3. Main Entry File (.pptd)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Presentation
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Theme
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

#### TextStyleConfig
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

#### CellStyle
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

#### TableStyleConfig
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### CustomFont
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

## 4. Page Files (.page)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Page
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

## 5. Elements
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### ElementBase
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Text (text box)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

#### TextContent
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

#### Rich Text Rules
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Shape (shape)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Line (line)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Image (image)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Icon (icon)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Table (table)
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

#### Cell
Full content: [Entry files, pages, and basic elements](pptd/deck-pages-and-basic-elements.md)

### Chart (charts)
Full content: [Charts and chart series](pptd/charts.md)

#### Chart
Full content: [Charts and chart series](pptd/charts.md)

#### ChartData
Full content: [Charts and chart series](pptd/charts.md)

#### General Rules
Full content: [Charts and chart series](pptd/charts.md)

#### TextStyle
Full content: [Charts and chart series](pptd/charts.md)

#### LineStyleConfig
Full content: [Charts and chart series](pptd/charts.md)

#### TitleConfig
Full content: [Charts and chart series](pptd/charts.md)

#### LegendConfig
Full content: [Charts and chart series](pptd/charts.md)

#### DataLabelConfig
Full content: [Charts and chart series](pptd/charts.md)

#### MarkerConfig
Full content: [Charts and chart series](pptd/charts.md)

#### AxisConfig
Full content: [Charts and chart series](pptd/charts.md)

#### SeriesDefaults
Full content: [Charts and chart series](pptd/charts.md)

#### SpokeAxisConfig
Full content: [Charts and chart series](pptd/charts.md)

#### LinearSeriesBase
Full content: [Charts and chart series](pptd/charts.md)

#### bar
Full content: [Charts and chart series](pptd/charts.md)

#### line
Full content: [Charts and chart series](pptd/charts.md)

#### area
Full content: [Charts and chart series](pptd/charts.md)

#### scatter
Full content: [Charts and chart series](pptd/charts.md)

#### bubble
Full content: [Charts and chart series](pptd/charts.md)

#### candlestick
Full content: [Charts and chart series](pptd/charts.md)

#### pie
Full content: [Charts and chart series](pptd/charts.md)

#### radar
Full content: [Charts and chart series](pptd/charts.md)

#### waterfall
Full content: [Charts and chart series](pptd/charts.md)

#### heatmap
Full content: [Charts and chart series](pptd/charts.md)

#### treemap
Full content: [Charts and chart series](pptd/charts.md)

#### sunburst
Full content: [Charts and chart series](pptd/charts.md)

#### sankey
Full content: [Charts and chart series](pptd/charts.md)

#### Field Quick Reference
Full content: [Charts and chart series](pptd/charts.md)

#### Examples
Full content: [Examples and animations](pptd/examples-and-animations.md)

## 6. Animations
Full content: [Examples and animations](pptd/examples-and-animations.md)

### Effects
Full content: [Examples and animations](pptd/examples-and-animations.md)

### Parameterized Emphasis Effects
Full content: [Examples and animations](pptd/examples-and-animations.md)

### Triggers and Groups
Full content: [Examples and animations](pptd/examples-and-animations.md)

### direction
Full content: [Examples and animations](pptd/examples-and-animations.md)

### motion-path
Full content: [Examples and animations](pptd/examples-and-animations.md)
