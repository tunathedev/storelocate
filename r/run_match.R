#!/usr/bin/env Rscript
# run_match.R — batch version of HEB Store Match.
#
# Reads a cohort file (xlsx/csv), finds the 3 closest stores + drive time for
# each partner, builds carpool groups, and writes a results .xlsx.
#
# Usage:
#   Rscript run_match.R <cohort.xlsx|csv> [output.xlsx] [carpool_minutes]
#
# Example:
#   Rscript run_match.R SORL_26B_Cohort.xlsx store-matches.xlsx 15

suppressWarnings(suppressMessages({
  library(readxl)
  library(openxlsx)
}))
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)[1])), "store_match.R"))

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("usage: Rscript run_match.R <cohort.xlsx|csv> [output.xlsx] [carpool_minutes]")
infile   <- args[1]
outfile  <- if (length(args) >= 2) args[2] else "store-matches.xlsx"
carpool_min <- if (length(args) >= 3) as.numeric(args[3]) else 15

# ---- read cohort -----------------------------------------------------------
read_cohort <- function(path) {
  if (grepl("\\.csv$", path, ignore.case = TRUE)) {
    read.csv(path, check.names = FALSE, stringsAsFactors = FALSE, colClasses = "character")
  } else {
    as.data.frame(readxl::read_excel(path), stringsAsFactors = FALSE)
  }
}

raw <- read_cohort(infile)
cols <- detect_columns(names(raw))
if (is.na(cols$name) || is.na(cols$address)) {
  stop("Could not detect name/address columns. Found headers: ", paste(names(raw), collapse = ", "))
}
people <- data.frame(
  name    = as.character(raw[[cols$name]]),
  area    = if (!is.na(cols$area)) as.character(raw[[cols$area]]) else "",
  address = as.character(raw[[cols$address]]),
  stringsAsFactors = FALSE
)
people <- people[nzchar(trimws(people$address)) | nzchar(trimws(people$name)), ]
cat(sprintf("Read %d partners from %s\n", nrow(people), infile))

# ---- match -----------------------------------------------------------------
stores <- load_stores()
cat(sprintf("Loaded %d stores\n", nrow(stores)))

results <- match_stores(
  people, stores, use_drive = TRUE,
  progress = function(frac, name) cat(sprintf("  [%3d%%] %s\n", round(frac * 100), name))
)
cp <- carpool_groups(results, threshold_min = carpool_min)
cat("Carpools: ", cp$summary, "\n", sep = "")

# ---- write -----------------------------------------------------------------
out <- build_export(results, cp$labels)
openxlsx::write.xlsx(out, outfile, overwrite = TRUE)
cat(sprintf("Wrote %s (%d rows)\n", outfile, nrow(out)))
