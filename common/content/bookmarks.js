// Copyright (c) 2006-2008 by Martin Stubenschrott <stubenschrott@vimperator.org>
// Copyright (c) 2007-2009 by Doug Kearns <dougkearns@gmail.com>
// Copyright (c) 2008-2010 by Kris Maglione <maglione.k@gmail.com>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

const DEFAULT_FAVICON = "chrome://mozapps/skin/places/defaultFavicon.png";

// also includes methods for dealing with keywords and search engines
const Bookmarks = Module("bookmarks", {
    init: function () {
        storage.addObserver("bookmark-cache", function (key, event, arg) {
            if (event == "add")
                autocommands.trigger("BookmarkAdd", arg);
            statusline.updateUrl();
        }, window);
    },

    get format() ({
        anchored: false,
        title: ["URL", "Info"],
        keys: { text: "url", description: "title", icon: "icon", extra: "extra", tags: "tags" },
        process: [template.icon, template.bookmarkDescription]
    }),

    // TODO: why is this a filter? --djk
    get: function get(filter, tags, maxItems, extra) {
        return completion.runCompleter("bookmark", filter, maxItems, tags, extra);
    },

    // if starOnly = true it is saved in the unfiledBookmarksFolder, otherwise in the bookmarksMenuFolder
    add: function add(starOnly, title, url, keyword, tags, force) {
        try {
            let uri = util.createURI(url);
            if (!force && bookmarks.isBookmarked(uri.spec))
                for (let bmark in bookmarkcache)
                    if (bmark.url == uri.spec) {
                        var id = bmark.id;
                        if (title)
                            services.get("bookmarks").setItemTitle(id, title);
                        break;
                    }

            if (id == undefined)
                id = services.get("bookmarks").insertBookmark(
                         services.get("bookmarks")[starOnly ? "unfiledBookmarksFolder" : "bookmarksMenuFolder"],
                         uri, -1, title || url);
            if (!id)
                return false;

            if (keyword)
                services.get("bookmarks").setKeywordForBookmark(id, keyword);
            if (tags) {
                PlacesUtils.tagging.untagURI(uri, null);
                PlacesUtils.tagging.tagURI(uri, tags);
            }
        }
        catch (e) {
            dactyl.log(e, 0);
            return false;
        }

        return true;
    },

    toggle: function toggle(url) {
        if (!url)
            return;

        let count = this.remove(url);
        if (count > 0)
            dactyl.echomsg({ domains: [util.getHost(url)], message: "Removed bookmark: " + url });
        else {
            let title = buffer.title || url;
            let extra = "";
            if (title != url)
                extra = " (" + title + ")";
            this.add(true, title, url);
            dactyl.echomsg({ domains: [util.getHost(url)], message: "Added bookmark: " + url + extra });
        }
    },

    isBookmarked: function isBookmarked(url) {
        try {
            return services.get("bookmarks")
                           .getBookmarkIdsForURI(makeURI(url), {})
                           .some(bookmarkcache.closure.isRegularBookmark);
        }
        catch (e) {
            return false;
        }
    },

    // returns number of deleted bookmarks
    remove: function remove(url) {
        try {
            let uri = util.newURI(url);
            let bmarks = services.get("bookmarks")
                                 .getBookmarkIdsForURI(uri, {})
                                 .filter(bookmarkcache.closure.isRegularBookmark);
            bmarks.forEach(services.get("bookmarks").removeItem);
            return bmarks.length;
        }
        catch (e) {
            dactyl.reportError(e);
            return 0;
        }
    },

    // TODO: add filtering
    // also ensures that each search engine has a Dactyl-friendly alias
    getSearchEngines: function getSearchEngines() {
        let searchEngines = [];
        for (let [, engine] in Iterator(services.get("browserSearch").getVisibleEngines({}))) {
            let alias = engine.alias;
            if (!alias || !/^[a-z0-9_-]+$/.test(alias))
                alias = engine.name.replace(/^\W*([a-zA-Z_-]+).*/, "$1").toLowerCase();
            if (!alias)
                alias = "search"; // for search engines which we can't find a suitable alias

            // make sure we can use search engines which would have the same alias (add numbers at the end)
            let newAlias = alias;
            for (let j = 1; j <= 10; j++) { // <=10 is intentional
                if (!searchEngines.some(function (item) item[0] == newAlias))
                    break;

                newAlias = alias + j;
            }
            // only write when it changed, writes are really slow
            if (engine.alias != newAlias)
                engine.alias = newAlias;

            searchEngines.push([engine.alias, engine.description, engine.iconURI && engine.iconURI.spec]);
        }

        return searchEngines;
    },

    getSuggestions: function getSuggestions(engineName, query, callback) {
        const responseType = "application/x-suggestions+json";

        let engine = services.get("browserSearch").getEngineByAlias(engineName);
        if (engine && engine.supportsResponseType(responseType))
            var queryURI = engine.getSubmission(query, responseType).uri.spec;
        if (!queryURI)
            return [];

        function process(resp) {
            let results = [];
            try {
                results = services.get("json").decode(resp.responseText)[1];
                results = [[item, ""] for ([k, item] in Iterator(results)) if (typeof item == "string")];
            }
            catch (e) {}
            if (!callback)
                return results;
            return callback(results);
        }

        let resp = util.httpGet(queryURI, callback && process);
        if (!callback)
            return process(resp);
        return null;
    },

    // TODO: add filtering
    // format of returned array:
    // [keyword, helptext, url]
    getKeywords: function getKeywords() {
        return bookmarkcache.keywords;
    },

    // full search string including engine name as first word in @param text
    // if @param useDefSearch is true, it uses the default search engine
    // @returns the url for the search string
    //          if the search also requires a postData, [url, postData] is returned
    getSearchURL: function getSearchURL(text, useDefsearch) {
        let searchString = (useDefsearch ? options["defsearch"] + " " : "") + text;

        // we need to make sure our custom alias have been set, even if the user
        // did not :open <tab> once before
        this.getSearchEngines();

        // ripped from Firefox
        function getShortcutOrURI(url) {
            var keyword = url;
            var param = "";
            var offset = url.indexOf(" ");
            if (offset > 0) {
                keyword = url.substr(0, offset);
                param = url.substr(offset + 1);
            }

            var engine = services.get("browserSearch").getEngineByAlias(keyword);
            if (engine) {
                var submission = engine.getSubmission(param, null);
                return [submission.uri.spec, submission.postData];
            }

            let [shortcutURL, postData] = PlacesUtils.getURLAndPostDataForKeyword(keyword);
            if (!shortcutURL)
                return [url, null];

            let data = window.unescape(postData || "");
            if (/%s/i.test(shortcutURL) || /%s/i.test(data)) {
                var charset = "";
                var matches = shortcutURL.match(/^(.*)\&mozcharset=([a-zA-Z][_\-a-zA-Z0-9]+)\s*$/);
                if (matches)
                    [, shortcutURL, charset] = matches;
                else {
                    try {
                        charset = services.get("history").getCharsetForURI(window.makeURI(shortcutURL));
                    }
                    catch (e) {}
                }
                var encodedParam;
                if (charset)
                    encodedParam = escape(window.convertFromUnicode(charset, param));
                else
                    encodedParam = encodeURIComponent(param);
                shortcutURL = shortcutURL.replace(/%s/g, encodedParam).replace(/%S/g, param);
                if (/%s/i.test(data))
                    postData = window.getPostDataStream(data, param, encodedParam, "application/x-www-form-urlencoded");
            }
            else if (param)
                return [shortcutURL, null];
            return [shortcutURL, postData];
        }

        let [url, postData] = getShortcutOrURI(searchString);

        if (url == searchString)
            return null;
        if (postData)
            return [url, postData];
        return url; // can be null
    },

    // if openItems is true, open the matching bookmarks items in tabs rather than display
    list: function list(filter, tags, openItems, maxItems) {
        // FIXME: returning here doesn't make sense
        //   Why the hell doesn't it make sense? --Kris
        // Because it unconditionally bypasses the final error message
        // block and does so only when listing items, not opening them. In
        // short it breaks the :bmarks command which doesn't make much
        // sense to me but I'm old-fashioned. --djk
        if (!openItems)
            return completion.listCompleter("bookmark", filter, maxItems, tags);
        let items = completion.runCompleter("bookmark", filter, maxItems, tags);

        if (items.length)
            return dactyl.open(items.map(function (i) i.url), dactyl.NEW_TAB);

        if (filter.length > 0 && tags.length > 0)
            dactyl.echoerr("E283: No bookmarks matching tags: " + tags.quote() + " and string: " + filter.quote());
        else if (filter.length > 0)
            dactyl.echoerr("E283: No bookmarks matching string: " + filter.quote());
        else if (tags.length > 0)
            dactyl.echoerr("E283: No bookmarks matching tags: " + tags.quote());
        else
            dactyl.echoerr("No bookmarks set");
        return null;
    }
}, {
}, {
    commands: function () {
        commands.add(["ju[mps]"],
            "Show jumplist",
            function () {
                let sh = history.session;
                commandline.commandOutput(template.jumps(sh.index, sh));
            },
            { argCount: "0" });

        // TODO: Clean this up.
        const tags = {
            names: ["-tags", "-T"],
            description: "A comma-separated list of tags",
            completer: function tags(context, args) {
                // TODO: Move the bulk of this to parseArgs.
                let filter = context.filter;
                let have = filter.split(",");

                args.completeFilter = have.pop();

                let prefix = filter.substr(0, filter.length - args.completeFilter.length);
                let tags = array.uniq(array.flatten([b.tags for ([k, b] in Iterator(bookmarkcache.bookmarks))]));

                return [[prefix + tag, tag] for ([i, tag] in Iterator(tags)) if (have.indexOf(tag) < 0)];
            },
            type: CommandOption.LIST
        };

        const title = {
            names: ["-title", "-t"],
            description: "Bookmark page title or description",
            completer: function title(context, args) {
                if (!args.bang)
                    return [[content.document.title, "Current Page Title"]];
                context.keys.text = "title";
                context.keys.description = "url";
                return bookmarks.get(args.join(" "), args["-tags"], null, { keyword: args["-keyword"], title: context.filter });
            },
            type: CommandOption.STRING
        };

        const keyword = {
            names: ["-keyword", "-k"],
            description: "Keyword by which this bookmark may be opened (:open {keyword})",
            completer: function keyword(context, args) {
                if (!args.bang)
                    return [];
                context.keys.text = "keyword";
                return bookmarks.get(args.join(" "), args["-tags"], null, { keyword: context.filter, title: args["-title"] });
            },
            type: CommandOption.STRING,
            validator: function (arg) /^\S+$/.test(arg)
        };

        commands.add(["bma[rk]"],
            "Add a bookmark",
            function (args) {
                let url = args.length == 0 ? buffer.URL : args[0];
                let title = args["-title"] || (args.length == 0 ? buffer.title : null);
                let keyword = args["-keyword"] || null;
                let tags = args["-tags"] || [];

                if (bookmarks.add(false, title, url, keyword, tags, args.bang)) {
                    let extra = (title == url) ? "" : " (" + title + ")";
                    dactyl.echomsg({ domains: [util.getHost(url)], message: "Added bookmark: " + url + extra },
                                   1, commandline.FORCE_SINGLELINE);
                }
                else
                    dactyl.echoerr("Exxx: Could not add bookmark " + title.quote(), commandline.FORCE_SINGLELINE);
            }, {
                argCount: "?",
                bang: true,
                completer: function (context, args) {
                    if (!args.bang) {
                        context.title = ["Page URL"];
                        context.completions = [[content.document.documentURI, "Current Location"]];
                        return;
                    }
                    completion.bookmark(context, args["-tags"], { keyword: args["-keyword"], title: args["-title"] });
                },
                options: [title, tags, keyword]
            });

        commands.add(["bmarks"],
            "List or open multiple bookmarks",
            function (args) {
                bookmarks.list(args.join(" "), args["-tags"] || [], args.bang, args["-max"]);
            },
            {
                bang: true,
                completer: function completer(context, args) {
                    context.quote = null;
                    context.filter = args.join(" ");
                    completion.bookmark(context, args["-tags"]);
                },
                options: [tags,
                    {
                        names: ["-max", "-m"],
                        description: "The maximum number of items to list or open",
                        type: CommandOption.INT
                    }
                ]
                // Not privateData, since we don't treat bookmarks as private
            });

        commands.add(["delbm[arks]"],
            "Delete a bookmark",
            function (args) {
                if (args.bang)
                    commandline.input("This will delete all bookmarks. Would you like to continue? (yes/[no]) ",
                        function (resp) {
                            if (resp && resp.match(/^y(es)?$/i)) {
                                bookmarkcache.bookmarks.forEach(function (bmark) { services.get("bookmarks").removeItem(bmark.id); });
                                dactyl.echomsg("All bookmarks deleted", 1, commandline.FORCE_SINGLELINE);
                            }
                        });
                else {
                    let url = args.string || buffer.URL;
                    let deletedCount = bookmarks.remove(url);

                    dactyl.echomsg({ domains: [util.getHost(url)], message: deletedCount + " bookmark(s) with url " + url.quote() + " deleted" },
                                   1, commandline.FORCE_SINGLELINE);
                }

            },
            {
                argCount: "?",
                bang: true,
                completer: function completer(context) completion.bookmark(context),
                literal: 0
            });
    },
    mappings: function () {
        var myModes = config.browserModes;

        mappings.add(myModes, ["a"],
            "Open a prompt to bookmark the current URL",
            function () {
                let options = {};

                let bmarks = bookmarks.get(buffer.URL).filter(function (bmark) bmark.url == buffer.URL);

                if (bmarks.length == 1) {
                    let bmark = bmarks[0];

                    options["-title"] = bmark.title;
                    if (bmark.keyword)
                        options["-keyword"] = bmark.keyword;
                    if (bmark.tags.length > 0)
                        options["-tags"] = bmark.tags.join(", ");
                }
                else {
                    if (buffer.title != buffer.URL)
                        options["-title"] = buffer.title;
                }

                commandline.open(":",
                    commands.commandToString({ command: "bmark", options: options, arguments: [buffer.URL] }),
                    modes.EX);
            });

        mappings.add(myModes, ["A"],
            "Toggle bookmarked state of current URL",
            function () { bookmarks.toggle(buffer.URL); });
    },
    options: function () {
        options.add(["defsearch", "ds"],
            "Set the default search engine",
            "string", "google",
            {
                completer: function completer(context) {
                    completion.search(context, true);
                    context.completions = [["", "Don't perform searches by default"]].concat(context.completions);
                }
            });

        options.add(["suggestengines"],
             "Engine Alias which has a feature of suggest",
             "stringlist", "google",
             {
                 completer: function completer(value) {
                     let engines = services.get("browserSearch").getEngines({})
                                           .filter(function (engine) engine.supportsResponseType("application/x-suggestions+json"));

                     return engines.map(function (engine) [engine.alias, engine.description]);
                 }
             });
    },
    completion: function () {
        completion.bookmark = function bookmark(context, tags, extra) {
            context.title = ["Bookmark", "Title"];
            context.format = bookmarks.format;
            for (let val in Iterator(extra || [])) {
                let [k, v] = val; // Need block scope here for the closure
                if (v)
                    context.filters.push(function (item) this.matchString(v, item[k]));
            }
            context.completions = bookmarkcache.bookmarks;
            completion.urls(context, tags);
        };

        completion.search = function search(context, noSuggest) {
            let [, keyword, space, args] = context.filter.match(/^\s*(\S*)(\s*)(.*)$/);
            let keywords = bookmarks.getKeywords();
            let engines = bookmarks.getSearchEngines();

            context.title = ["Search Keywords"];
            context.completions = keywords.concat(engines);
            context.keys = { text: 0, description: 1, icon: 2 };

            if (!space || noSuggest)
                return;

            context.fork("suggest", keyword.length + space.length, this, "searchEngineSuggest",
                    keyword, true);

            let item = keywords.filter(function (k) k.keyword == keyword)[0];
            if (item && item.url.indexOf("%s") > -1)
                context.fork("keyword/" + keyword, keyword.length + space.length, null, function (context) {
                    context.format = history.format;
                    context.title = [keyword + " Quick Search"];
                    // context.background = true;
                    context.compare = CompletionContext.Sort.unsorted;
                    context.generate = function () {
                        let [begin, end] = item.url.split("%s");

                        return history.get({ uri: window.makeURI(begin), uriIsPrefix: true }).map(function (item) {
                            let rest = item.url.length - end.length;
                            let query = item.url.substring(begin.length, rest);
                            if (item.url.substr(rest) == end && query.indexOf("&") == -1)
                                try {
                                    item.url = decodeURIComponent(query.replace(/#.*/, "").replace(/\+/g, " "));
                                    return item;
                                }
                                catch (e) {}
                            return null;
                        }).filter(util.identity);
                    };
                });
        };

        completion.searchEngineSuggest = function searchEngineSuggest(context, engineAliases, kludge) {
            if (!context.filter)
                return;

            let engineList = (engineAliases || options["suggestengines"].join(",") || "google").split(",");

            let completions = [];
            engineList.forEach(function (name) {
                let engine = services.get("browserSearch").getEngineByAlias(name);
                if (!engine)
                    return;
                let [, word] = /^\s*(\S+)/.exec(context.filter) || [];
                if (!kludge && word == name) // FIXME: Check for matching keywords
                    return;
                let ctxt = context.fork(name, 0);

                ctxt.title = [engine.description + " Suggestions"];
                ctxt.compare = CompletionContext.Sort.unsorted;
                ctxt.incomplete = true;
                bookmarks.getSuggestions(name, ctxt.filter, function (compl) {
                    ctxt.incomplete = false;
                    ctxt.completions = compl;
                });
            });
        };

        completion.addUrlCompleter("S", "Suggest engines", completion.searchEngineSuggest);
        completion.addUrlCompleter("b", "Bookmarks", completion.bookmark);
        completion.addUrlCompleter("s", "Search engines and keyword URLs", completion.search);
    }
});

// vim: set fdm=marker sw=4 ts=4 et:
