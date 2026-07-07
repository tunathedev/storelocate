# app.R — Shiny UI for HEB Store Match (thin layer over store_match.R).
#
# Run:  R -e "shiny::runApp('r', port=3700)"   (from the repo root)
#   or: setwd('r'); shiny::runApp('.')
#
# Mirrors the web tool: PIN gate (1905), upload, closest-3 table with drive
# time, carpool panel, and Excel download. Geocoding = Census (+OSM fallback),
# drive time = OSRM. No API key.

suppressWarnings(suppressMessages({
  library(shiny)
  library(DT)
  library(readxl)
  library(openxlsx)
}))
source("store_match.R", local = TRUE)   # assumes working dir is r/

MASTER_PIN <- "1905"

ui <- fluidPage(
  tags$head(tags$style(HTML("
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
    .brandbar{background:#ee3124;color:#fff;padding:12px 18px;font-weight:800;font-size:1.15rem;border-radius:8px;margin-bottom:16px}
    .banner{background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;border-radius:8px;padding:10px 14px;font-size:.85rem;margin-bottom:14px}
    .cp-group{border:1px solid #e5e7eb;border-left:3px solid #ee3124;border-radius:8px;padding:8px 12px;margin-bottom:8px}
    .cp-badge{background:#ee3124;color:#fff;border-radius:6px;padding:1px 8px;margin-right:6px;font-size:.8rem}
    .err{color:#c8291d;font-weight:600}
  "))),
  uiOutput("screen")
)

server <- function(input, output, session) {
  unlocked <- reactiveVal(FALSE)
  rv <- reactiveValues(results = NULL, carpool = NULL, stores = NULL)

  # ---- screen router (PIN gate vs app) ----
  output$screen <- renderUI({
    if (!unlocked()) {
      tagList(
        div(class = "brandbar", "HEB Store Match — Manager Placement"),
        wellPanel(
          h4("Enter access PIN"),
          passwordInput("pin", NULL, placeholder = "PIN"),
          actionButton("unlock", "Unlock", class = "btn-danger"),
          textOutput("pinerr")
        )
      )
    } else {
      tagList(
        div(class = "brandbar", "HEB Store Match — Manager Placement"),
        div(class = "banner", strong("Confidential. "),
            "Home addresses are geocoded via the U.S. Census; drive times via OSRM. Nothing is written to disk."),
        fluidRow(
          column(4,
            fileInput("file", "Upload cohort (.xlsx / .csv)", accept = c(".xlsx", ".xls", ".csv")),
            uiOutput("mapping"),
            sliderInput("carpool_min", "Carpool: group homes within (min drive)", 5, 30, 15, step = 5),
            actionButton("run", "Find closest stores", class = "btn-danger"),
            br(), br(),
            downloadButton("dl", "Download Excel")
          ),
          column(8,
            h4("Closest stores"),
            DT::dataTableOutput("results"),
            hr(),
            h4(textOutput("cp_summary", inline = TRUE)),
            uiOutput("carpool")
          )
        )
      )
    }
  })

  observeEvent(input$unlock, {
    if (identical(input$pin, MASTER_PIN)) unlocked(TRUE)
    else output$pinerr <- renderText("Incorrect PIN")
  })

  # ---- read + column mapping ----
  cohort <- reactive({
    req(input$file)
    path <- input$file$datapath
    df <- if (grepl("\\.csv$", input$file$name, ignore.case = TRUE)) {
      read.csv(path, check.names = FALSE, stringsAsFactors = FALSE, colClasses = "character")
    } else {
      as.data.frame(readxl::read_excel(path), stringsAsFactors = FALSE)
    }
    df
  })

  output$mapping <- renderUI({
    df <- cohort(); hdr <- names(df); g <- detect_columns(hdr)
    sel <- function(id, lab, idx) selectInput(id, lab, choices = hdr,
                                              selected = if (!is.na(idx)) hdr[idx] else hdr[1])
    tagList(
      helpText(sprintf("%d partners detected", nrow(df))),
      sel("col_name", "Name column", g$name),
      sel("col_area", "Area column", g$area),
      sel("col_addr", "Home address column", g$address)
    )
  })

  # ---- run pipeline ----
  observeEvent(input$run, {
    df <- cohort()
    people <- data.frame(
      name    = as.character(df[[input$col_name]]),
      area    = as.character(df[[input$col_area]]),
      address = as.character(df[[input$col_addr]]),
      stringsAsFactors = FALSE
    )
    if (is.null(rv$stores)) rv$stores <- load_stores()
    withProgress(message = "Matching…", value = 0, {
      res <- match_stores(people, rv$stores, use_drive = TRUE,
                          progress = function(frac, name) setProgress(value = frac, detail = name))
      rv$results <- res
      rv$carpool <- carpool_groups(res, threshold_min = input$carpool_min)
    })
  })

  # recompute carpools when the threshold changes (without re-geocoding)
  observeEvent(input$carpool_min, {
    if (!is.null(rv$results)) rv$carpool <- carpool_groups(rv$results, threshold_min = input$carpool_min)
  }, ignoreInit = TRUE)

  # ---- results table ----
  output$results <- DT::renderDataTable({
    req(rv$results)
    fmt <- function(m) {
      if (!is.null(m$error)) return(m$error)
      paste(sapply(seq_len(nrow(m$top)), function(i) {
        r <- m$top[i, ]
        drive <- if (!is.na(r$minutes)) sprintf("%d min", round(r$minutes)) else "—"
        miles <- if (!is.na(r$miles)) r$miles else r$straightMi
        sprintf("%d. %s (%s, %.1f mi)", i, title_case(r$name), drive, miles)
      }), collapse = " | ")
    }
    df <- do.call(rbind, lapply(rv$results, function(r)
      data.frame(Partner = r$name, Area = r$area,
                 `Home address` = r$address,
                 `Closest stores` = fmt(r), check.names = FALSE)))
    DT::datatable(df, rownames = FALSE, options = list(pageLength = 25, dom = "t"))
  })

  output$cp_summary <- renderText(if (!is.null(rv$carpool)) paste("Suggested carpools —", rv$carpool$summary) else "")

  output$carpool <- renderUI({
    req(rv$carpool)
    if (!length(rv$carpool$detail)) return(helpText("No carpool pairs within range."))
    lapply(names(rv$carpool$detail), function(label) {
      div(class = "cp-group", span(class = "cp-badge", "▲"), strong(label), ": ",
          paste(rv$carpool$detail[[label]], collapse = ", "))
    })
  })

  # ---- download ----
  output$dl <- downloadHandler(
    filename = function() "store-matches.xlsx",
    content = function(f) {
      req(rv$results)
      out <- build_export(rv$results, if (!is.null(rv$carpool)) rv$carpool$labels else NULL)
      openxlsx::write.xlsx(out, f)
    }
  )
}

shinyApp(ui, server)
