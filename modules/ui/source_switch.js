import { select as d3_select } from 'd3-selection';
import { t } from '../core/localizer';


export function uiSourceSwitch(context) {
    var keys;

    function click(d3_event) {
        d3_event.preventDefault();

        var osm = context.services.get('osm');
        if (!osm) return;

        if (context.inIntro()) return;

        if (context.history().hasChanges() &&
            !window.confirm(t('source_switch.lose_changes'))) return;

        var isLive = d3_select(this)
            .classed('live');

        isLive = !isLive;
        context.enter('browse');
        context.history().clearSaved();          // remove saved history
        context.flush();                         // remove stored data

        d3_select(this)
            .html(isLive ? t.html('source_switch.live') : t.html('source_switch.dev'))
            .classed('live', isLive)
            .classed('chip', isLive);

        osm.switch(isLive ? keys[0] : keys[1]);  // switch connection (warning: dispatches 'change' event)
    }

    var sourceSwitch = function(selection) {
        selection
            .append('a')
            .attr('href', '#')
            .html(t.html('source_switch.live'))
            .attr('class', 'live chip')
            .on('click', click);
    };


    sourceSwitch.keys = function(val) {
        if (!arguments.length) return keys;
        keys = val;
        return sourceSwitch;
    };


    return sourceSwitch;
}
