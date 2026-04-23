(function () {
    "use strict";

    var path = window.location.pathname;
    var isZh = path.indexOf("/zh/") !== -1;
    var currentLang = isZh ? "zh" : "en";

    function buildSwitchUrl(targetLang) {
        if (currentLang === targetLang) return null;
        if (targetLang === "zh") {
            return path.replace(/\/en\//, "/zh/");
        } else {
            return path.replace(/\/zh\//, "/en/");
        }
    }

    function insertSwitcher() {
        var rightButtons = document.querySelector(".right-buttons");
        if (!rightButtons) return;

        var container = document.createElement("div");
        container.className = "lang-switcher";

        var enLink = document.createElement("a");
        enLink.textContent = "EN";
        enLink.title = "English";
        if (currentLang === "en") {
            enLink.className = "active";
            enLink.href = "#";
        } else {
            enLink.href = buildSwitchUrl("en") || "#";
        }

        var zhLink = document.createElement("a");
        zhLink.textContent = "中文";
        zhLink.title = "中文版";
        if (currentLang === "zh") {
            zhLink.className = "active";
            zhLink.href = "#";
        } else {
            zhLink.href = buildSwitchUrl("zh") || "#";
        }

        container.appendChild(enLink);
        container.appendChild(zhLink);
        rightButtons.insertBefore(container, rightButtons.firstChild);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", insertSwitcher);
    } else {
        insertSwitcher();
    }
})();
