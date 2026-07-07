# store_match.R — core logic for HEB Store Match, ported from app.js
#
# Pure functions (no UI). Used by both run_match.R (batch) and app.R (Shiny).
# Engine: US Census geocoding via {tidygeocoder} (falls back to OSM/Nominatim),
# drive time via {osrm} (public OSRM server). No API key required.
#
# Mirrors the web tool: geocode home addresses -> rank stores by straight-line
# distance -> drive time for the nearest candidates -> 3 closest per partner ->
# carpool groups within each Area.

suppressWarnings(suppressMessages({
  library(jsonlite)
  library(tidygeocoder)
  library(osrm)
}))

# Use the same public OSRM server as the web app. (Newer {osrm} versions default
# to a different demo server/profile; set explicitly for consistency.)
options(osrm.server = "https://router.project-osrm.org/", osrm.profile = "driving")

NEAREST_CANDIDATES <- 8   # straight-line shortlist sent to the router
TOP_N              <- 3   # stores shown per partner

`%||%` <- function(a, b) if (is.null(a) || is.na(a) || !nzchar(a)) b else a

# ---- helpers ---------------------------------------------------------------

# Normalize whitespace (incl. non-breaking/unicode spaces) and space after commas.
clean_address <- function(a) {
  a <- as.character(a)
  a <- gsub("[\\s\\xA0]+", " ", a, perl = TRUE)   # collapse whitespace incl. non-breaking space
  a <- gsub(",(?=\\S)", ", ", a, perl = TRUE)
  trimws(a)
}

# Vectorized haversine distance in miles from one point to vectors of lat/lon.
haversine_mi <- function(lat1, lon1, lat2, lon2) {
  R <- 3958.7613
  to_rad <- function(d) d * pi / 180
  dlat <- to_rad(lat2 - lat1)
  dlon <- to_rad(lon2 - lon1)
  a <- sin(dlat / 2)^2 + cos(to_rad(lat1)) * cos(to_rad(lat2)) * sin(dlon / 2)^2
  R * 2 * asin(pmin(1, sqrt(a)))
}

# Nice-case a store name/address (mirrors titleCase in app.js, loosely).
title_case <- function(s) {
  s <- tolower(as.character(s))
  s <- gsub("\\b([a-z])", "\\U\\1", s, perl = TRUE)
  gsub("\\b(Ih|Us|Fm|Sh|Nw|Se|Ne|Sw|Rd|Dr|St|Blvd|Hwy|Ln|Pkwy)\\b", "\\U\\1", s, perl = TRUE)
}

# ---- data ------------------------------------------------------------------

# Load stores.json (the same file the web app uses).
load_stores <- function(path = NULL) {
  candidates <- c(path, "../data/stores.json", "data/stores.json",
                  file.path(dirname(getwd()), "data", "stores.json"))
  candidates <- Filter(Negate(is.null), candidates)
  hit <- candidates[file.exists(candidates)]
  if (!length(hit)) stop("stores.json not found; pass path= explicitly")
  d <- jsonlite::fromJSON(hit[[1]])
  s <- d$stores
  s[is.finite(s$lat) & is.finite(s$lon), ]
}

# ---- geocoding -------------------------------------------------------------

# Geocode a character vector of addresses. Census first, OSM for any misses.
# Returns a data.frame: address, lat, lon (NA lat/lon where not found).
geocode_addresses <- function(addresses) {
  clean <- vapply(addresses, clean_address, character(1), USE.NAMES = FALSE)
  uniq  <- unique(clean[nzchar(clean)])
  if (!length(uniq)) return(data.frame(address = clean, lat = NA_real_, lon = NA_real_))

  g <- tidygeocoder::geo(address = uniq, method = "census",
                         lat = "lat", long = "lon", quiet = TRUE, progress_bar = FALSE)
  miss <- is.na(g$lat) | is.na(g$lon)
  if (any(miss)) {
    g2 <- tidygeocoder::geo(address = g$address[miss], method = "osm",
                            lat = "lat", long = "lon", quiet = TRUE, progress_bar = FALSE)
    g$lat[miss] <- g2$lat
    g$lon[miss] <- g2$lon
  }
  idx <- match(clean, g$address)   # map back to (possibly repeated) input order
  data.frame(address = clean, lat = g$lat[idx], lon = g$lon[idx])
}

# ---- drive time ------------------------------------------------------------

# Drive minutes + miles from one origin to a set of destination rows.
# origin: list(lat, lon); dests: data.frame with lat, lon (and id/name).
# Returns data.frame with the dest columns plus minutes, miles (NA on failure).
drive_from <- function(origin, dests) {
  out <- dests
  out$minutes <- NA_real_
  out$miles   <- NA_real_
  res <- tryCatch({
    src <- data.frame(id = "home", lon = origin$lon, lat = origin$lat)
    dst <- data.frame(id = as.character(seq_len(nrow(dests))), lon = dests$lon, lat = dests$lat)
    osrm::osrmTable(src = src, dst = dst, measure = c("duration", "distance"))
  }, error = function(e) NULL)
  if (!is.null(res)) {
    out$minutes <- as.numeric(res$durations[1, ])
    if (!is.null(res$distances)) out$miles <- as.numeric(res$distances[1, ]) / 1609.34
  }
  out
}

# Full pairwise drive-minute matrix among a set of points (for carpools).
drive_matrix_minutes <- function(points) {
  n <- nrow(points)
  if (n < 2) return(matrix(0, n, n))
  res <- tryCatch({
    loc <- data.frame(id = as.character(seq_len(n)), lon = points$lon, lat = points$lat)
    osrm::osrmTable(loc = loc, measure = "duration")
  }, error = function(e) NULL)
  if (!is.null(res)) return(res$durations)
  m <- matrix(NA_real_, n, n)   # fallback: ~35 mph estimate from straight-line
  for (i in seq_len(n)) for (j in seq_len(n)) {
    m[i, j] <- haversine_mi(points$lat[i], points$lon[i], points$lat[j], points$lon[j]) / 35 * 60
  }
  m
}

# ---- matching --------------------------------------------------------------

# people: data.frame(name, area, address). Returns a list of per-partner results:
# list(name, area, address, geo=list(lat,lon)|NULL, top=data.frame|NULL, error=chr|NULL).
match_stores <- function(people, stores, use_drive = TRUE, progress = NULL) {
  geo <- geocode_addresses(people$address)
  results <- vector("list", nrow(people))
  for (i in seq_len(nrow(people))) {
    if (is.function(progress)) progress(i / nrow(people), people$name[i])
    p <- list(name = people$name[i], area = people$area[i], address = people$address[i])
    lat <- geo$lat[i]; lon <- geo$lon[i]
    if (is.na(lat) || is.na(lon)) { p$error <- "Address not found"; results[[i]] <- p; next }
    p$geo <- list(lat = lat, lon = lon)

    stores$straightMi <- haversine_mi(lat, lon, stores$lat, stores$lon)
    ranked <- stores[order(stores$straightMi), ]
    shortlist <- utils::head(ranked, NEAREST_CANDIDATES)

    if (use_drive) {
      dt <- drive_from(p$geo, shortlist)
      dt <- dt[order(ifelse(is.na(dt$minutes), Inf, dt$minutes)), ]
      p$top <- utils::head(dt, TOP_N)
    } else {
      shortlist$minutes <- NA_real_; shortlist$miles <- NA_real_
      p$top <- utils::head(shortlist, TOP_N)
    }
    results[[i]] <- p
  }
  results
}

# ---- carpools --------------------------------------------------------------

# Connected components of partners within `threshold` drive-minutes (undirected).
components_within <- function(mins, threshold) {
  n <- nrow(mins)
  comp <- rep(NA_integer_, n)
  cid <- 0L
  for (i in seq_len(n)) {
    if (!is.na(comp[i])) next
    cid <- cid + 1L
    queue <- i; comp[i] <- cid
    while (length(queue)) {
      v <- queue[1]; queue <- queue[-1]
      for (j in seq_len(n)) {
        if (is.na(comp[j]) && j != v) {
          d <- suppressWarnings(min(mins[v, j], mins[j, v], na.rm = TRUE))
          if (is.finite(d) && d <= threshold) { comp[j] <- cid; queue <- c(queue, j) }
        }
      }
    }
  }
  comp
}

# Assign carpool group labels per Area. Returns list(labels, summary, detail).
carpool_groups <- function(results, threshold_min = 15) {
  ok <- Filter(function(r) is.null(r$error) && !is.null(r$geo), results)
  labels <- setNames(rep("Solo", length(ok)), vapply(ok, function(r) r$name, character(1)))
  areas <- unique(vapply(ok, function(r) trimws(r$area %||% "(no area)"), character(1)))
  n_groups <- 0L; n_paired <- 0L
  detail <- list()

  for (area in areas) {
    members <- Filter(function(r) trimws(r$area %||% "(no area)") == area, ok)
    if (length(members) < 2) next
    pts <- data.frame(
      lat = vapply(members, function(r) r$geo$lat, numeric(1)),
      lon = vapply(members, function(r) r$geo$lon, numeric(1))
    )
    mins <- drive_matrix_minutes(pts)
    comp <- components_within(mins, threshold_min)
    gletter <- 0L
    for (cc in sort(unique(comp))) {
      idx <- which(comp == cc)
      if (length(idx) < 2) next
      gletter <- gletter + 1L
      label <- sprintf("%s · Group %s", area, LETTERS[gletter])
      nm <- vapply(members[idx], function(r) r$name, character(1))
      labels[nm] <- label
      n_groups <- n_groups + 1L; n_paired <- n_paired + length(idx)
      detail[[label]] <- nm
    }
  }
  list(labels = labels,
       summary = sprintf("%d carpools · %d paired · %d solo",
                         n_groups, n_paired, length(ok) - n_paired),
       detail = detail)
}

# ---- export ----------------------------------------------------------------

# Build the flat export data.frame (mirrors exportRows() in app.js).
build_export <- function(results, carpool_labels = NULL) {
  rows <- lapply(results, function(r) {
    cp <- if (!is.null(carpool_labels) && r$name %in% names(carpool_labels)) carpool_labels[[r$name]] else ""
    row <- list(`Partner Name` = r$name, Area = r$area, `Carpool Group` = cp, `Home Address` = r$address)
    for (i in seq_len(TOP_N)) {
      m <- if (!is.null(r$top) && i <= nrow(r$top)) r$top[i, ] else NULL
      if (!is.null(m)) {
        row[[sprintf("Store %d", i)]]              <- title_case(m$name)
        row[[sprintf("Store %d ID", i)]]           <- m$id
        row[[sprintf("Store %d Drive (min)", i)]]  <- if (!is.na(m$minutes)) round(m$minutes) else ""
        miles <- if (!is.na(m$miles)) m$miles else m$straightMi
        row[[sprintf("Store %d Miles", i)]]        <- round(miles, 1)
      } else {
        val <- if (!is.null(r$error)) r$error else ""
        row[[sprintf("Store %d", i)]] <- val
        row[[sprintf("Store %d ID", i)]] <- ""
        row[[sprintf("Store %d Drive (min)", i)]] <- ""
        row[[sprintf("Store %d Miles", i)]] <- ""
      }
    }
    as.data.frame(row, check.names = FALSE, stringsAsFactors = FALSE)
  })
  do.call(rbind, rows)
}

# Detect name/area/address column indices from cohort headers (mirrors guess()).
detect_columns <- function(headers) {
  low <- tolower(trimws(headers))
  pick <- function(keys) {
    i <- which(Reduce(`|`, lapply(keys, function(k) grepl(k, low, fixed = TRUE))))
    if (length(i)) i[1] else NA_integer_
  }
  list(name = pick(c("name", "partner", "employee")),
       area = pick(c("area", "region", "district")),
       address = pick(c("location", "address", "home", "residence")))
}
