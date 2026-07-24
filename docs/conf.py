# Configuration file for the Sphinx documentation builder.
#
# For the full list of built-in configuration values, see the documentation:
# https://www.sphinx-doc.org/en/master/usage/configuration.html

# -- Project information -----------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#project-information

project = "Pumice"
copyright = "2026, Ji-ho Lee"
author = "Ji-ho Lee"
release = "0.0.17"
version = "0.0.17"

# -- General configuration ----------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#general-configuration

extensions = [
    "sphinx.ext.autosectionlabel",
]

templates_path = ["_templates"]
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

# -- Internationalization ------------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#options-for-internationalization

language = "en"
locale_dirs = ["locale/"]
gettext_compact = False
gettext_uuid = True

# -- Options for HTML output ---------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#options-for-html-output

html_theme = "sphinx_book_theme"
html_static_path = ["_static"]
html_js_files = ["custom.js"]
html_title = f"{project} Documentation"

html_theme_options = {
    "repository_url": "https://github.com/search5/pumice",
    "use_repository_button": True,
    "use_issues_button": True,
    "use_edit_page_button": False,
    "path_to_docs": "docs",
    "navbar_end": ["version-switcher"],
    "switcher": {
        "json_url": "_static/switcher.json",
        # Placeholder so the config-inited hook below can safely assign to
        # this key without raising a KeyError, regardless of build order.
        "version_match": "en",
    },
}

html_context = {
    "default_mode": "auto",
}


# -- Dynamic per-language titles (HTML tab title) -------------------------------
#
# Sphinx builds each language as a separate `-D language=xx` invocation, so we
# hook into `config-inited` to set the human-facing title (and the theme's
# version/language switcher state) based on whichever language this
# particular build run is using.


def update_language_titles(app, config):
    app.config.html_theme_options["switcher"]["version_match"] = config.language
    if config.language == "ko":
        app.config.html_title = f"{project} 문서 (한국어)"
    else:
        app.config.html_title = f"{project} Documentation (EN)"


def setup(app):
    app.connect("config-inited", update_language_titles)
