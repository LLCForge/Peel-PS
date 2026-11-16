// Geçiş sırası: önce başlatıcı ve ` temizliği, sonra katman açma, katlama, ad çözme ve kullanılmayan atamalar; her tur
// bu sırayla döner.
import * as launcher from '../passes/launcher.js';
import * as ticks from '../passes/ticks.js';
import * as layers from '../passes/layers.js';
import * as fold from '../passes/fold.js';
import * as names from '../passes/names.js';
import * as unused from '../passes/unused.js';

export const PASSES = [launcher, ticks, layers, fold, names, unused];
