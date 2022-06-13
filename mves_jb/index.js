'use strict';

var libQ = require('kew');
var fs=require('fs-extra');
var path = require('path');
//var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;

const io = require('socket.io-client');

const {SerialPort} = require('serialport')
const {ReadlineParser} = require('@serialport/parser-readline')

const readline = require('readline');
const chokidar = require('chokidar');

const MVES_MUSIC_PATH = '/media'; 
const MVES_LIBRARY_PATH = 'music-library/USB';

module.exports = mvesJb;

function mvesJb(context) {
	var self = this;

	this.context = context;
	this.commandRouter = this.context.coreCommand;
	this.logger = this.context.logger;
	this.configManager = this.context.configManager;

}

mvesJb.prototype.onVolumioStart = function()
{
	var self = this;
	var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
	
	self.info("File di configurazione: " + configFile);
	
	this.config = new (require('v-conf'))();
	this.config.loadFile(configFile);

    return libQ.resolve();
}

mvesJb.prototype.onStart = function() {
    
	var self = this;
	var defer=libQ.defer();

	self.rl = null;
	self.cavaInstance = null;
	self.port = new SerialPort({ path: '/dev/serial0', baudRate: 115200 });
	self.parser = self.port.pipe(new ReadlineParser({ delimiter: '\n' }));
	self.parser.on('data', (uart_msg) => {self.interfaceMessage(uart_msg);});
	self.updateTimer = null;
	self.currentStatus = null;
	
	//album delle tracce avviabili da tastiera
	self.discs = {};
	
	//scansione directory
	fs.readdir(MVES_MUSIC_PATH, {'withFileTypes': true}, (err, folders) => {

		folders.forEach( (folder) => {

			self.discs[folder.name] = {};
			self.discs[folder.name]['disc'] = folder.name;
			self.discs[folder.name]['path'] = path.join(MVES_MUSIC_PATH, folder.name);
			self.discs[folder.name]['tracks'] = [];

			fs.readdir(self.discs[folder.name]['path'], {'withFileTypes': true}, (err, items) => {

				items.forEach( (item) => {
					if ( item.isFile() )
						self.discs[folder.name]['tracks'].push(path.join(self.discs[folder.name]['path'], item.name));
				});
			});

			//aggiungo un listener alla directory;
			let watcher = chokidar.watch(path.join(MVES_MUSIC_PATH, folder.name), {'ignored': /^\./, 'awaitWriteFinish': true, 'persistent': true});

			watcher.on('add', (file) => {
				//file aggiunto
				if ( !self.discs[folder.name]['tracks'].includes(file) )
					self.discs[folder.name]['tracks'].push(file);

				if ( self.ioSocket != null ) self.ioSocket.emit('updateDb');

			}).on('unlink', (file) => {
				//file rimosso
				self.discs[folder.name]['tracks'] = self.discs[folder.name]['tracks'].filter( (val, idx, arr) => {
					val != file;
				});
			});
		});
	});

	try
	{
		self.ioSocket = io.connect('http://localhost:3000');
		self.ioSocket.on('pushState', (newStatus) => {self.onStatusUpdate(newStatus);});
		self.ioSocket.on('pushQueue', (queue) => {self.onQueueUpdate(queue);});
	}
	catch (ioerr)
	{
		self.info(ioerr)
	}
	
	self.restartSpectrumAnalyzer(false);
	
	defer.resolve();
	
    return defer.promise;
};

mvesJb.prototype.onStatusUpdate = function(data)
{
	var self = this;
	
	self.currentStatus = data;
	
	let uart_status = {};
	
	uart_status['opcode'] = 'jb_status';
	uart_status['status'] = 1;
	
	if ( data['status'] === 'play' ) 
	{
		if ( self.updateTimer == null ) self.updateTimer = setInterval(() => {self.ioSocket.emit('getState');}, 1000);
		uart_status['status'] = 2;
	}
	else
	{
		if ( data['status'] === 'stop' ) uart_status['status'] = 1;
		else if ( data['status'] === 'pause' ) uart_status['status'] = 3;
		
		clearInterval(self.updateTimer);
		self.updateTimer = null;
	}
	
	uart_status['track'] = data['title'];
	uart_status['album'] = data['album'];
	uart_status['artist'] = data['artist'];
	uart_status['pos'] = data['seek'];
	uart_status['len'] = data['duration'];
	uart_status['vol'] = data['volume'];
	
	if ( data['trackType'] === 'spotify' ) 
		uart_status['spotify'] = 1;
	else
		uart_status['spotify'] = 0;
	
	let uart_msg = JSON.stringify(uart_status) + '\n';
	
	try
	{
		self.port.write(uart_msg);
	}
	catch(uart_err)
	{
		self.info(uart_err);
	}
};

mvesJb.prototype.onQueueUpdate = function(data)
{
	var self = this;
	
	self.info(JSON.stringify(data));
	
	let num_items = data.length;
	
	let uart_status = {};
	
	uart_status['opcode'] = 'jb_queue';
	uart_status['items'] = num_items;
	
	let uart_msg = JSON.stringify(uart_status) + '\n';
	
	try
	{
		self.port.write(uart_msg);
	}
	catch(uart_err)
	{
		self.info(uart_err);
	}
}

mvesJb.prototype.onStop = function() {
    var self = this;
    var defer=libQ.defer();

    // Once the Plugin has successfull stopped resolve the promise
    self.stopSpectrumAnalyzer();
	self.ioSocket.disconnect();
	
	defer.resolve();

    return libQ.resolve();
};

mvesJb.prototype.onRestart = function() {
    var self = this;
    // Optional, use if you need it
};

// Configuration Methods -----------------------------------------------------------------------------

mvesJb.prototype.getUIConfig = function() {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function(uiconf)
        {
			uiconf.sections[0].content.findById = function (item_id) {
				return this.find((item) => {
					return item.id === item_id; 
			})};
			
			let pr = self.config.get('pr');
			let pg = self.config.get('pg');
			let pb = self.config.get('pb');
			let sbr = self.config.get('sbr');
			let sbg = self.config.get('sbg');
			let sbb = self.config.get('sbb');
			let sbkr = self.config.get('sbkr');
			let sbkg = self.config.get('sbkg');
			let sbkb = self.config.get('sbkb');
			
			//self.info('GET UIConfig ' + uiconf.sections[0].content);
			self.info('GET PR ' + pr);
			self.info('GET PG ' + pg);
			self.info('GET PB ' + pb);
			
			self.info('GET SBR ' + sbr);
			self.info('GET SBG ' + sbg);
			self.info('GET SBB ' + sbg);
			
			self.info('GET SBKR ' + sbkr);
			self.info('GET SBKG ' + sbkg);
			self.info('GET SBKB ' + sbkb);
			
			let pr_item = uiconf.sections[0].content.findById('pr');
			let pg_item = uiconf.sections[0].content.findById('pb');
			let pb_item = uiconf.sections[0].content.findById('pg');
			
			let sbr_item = uiconf.sections[0].content.findById('sbr');
			let sbg_item = uiconf.sections[0].content.findById('sbg');
			let sbb_item = uiconf.sections[0].content.findById('sbb');
			
			let sbkr_item = uiconf.sections[0].content.findById('sbkr');
			let sbkg_item = uiconf.sections[0].content.findById('sbkg');
			let sbkb_item = uiconf.sections[0].content.findById('sbkb');
			
			if ( pr_item ) pr_item.value = pr;
			if ( pg_item ) pg_item.value = pg;
			if ( pb_item ) pb_item.value = pb;
			
			if ( sbr_item ) sbr_item.value = sbr;
			if ( sbg_item ) sbg_item.value = sbg;
			if ( sbb_item ) sbb_item.value = sbb;
			
			if ( sbkr_item ) sbkr_item.value = sbkr;
			if ( sbkg_item ) sbkg_item.value = sbkg;
			if ( sbkb_item ) sbkb_item.value = sbkb;
			
			let color_config = {};
			
			color_config['pr'] = parseInt(pr);
			color_config['pb'] = parseInt(pb);
			color_config['pg'] = parseInt(pb);
			
			color_config['sbr'] = parseInt(sbr);
			color_config['sbb'] = parseInt(sbb);
			color_config['sbg'] = parseInt(sbg);
			
			color_config['sbkr'] = parseInt(sbkr);
			color_config['sbkg'] = parseInt(sbkg);
			color_config['sbkb'] = parseInt(sbkb);
			
			self.sendColorConfiguration(color_config);
			
            defer.resolve(uiconf);
        })
        .fail(function()
        {
            defer.reject(new Error());
        });

    return defer.promise;
};

mvesJb.prototype.getConfigurationFiles = function() {
	return ['config.json'];
}

mvesJb.prototype.setUIConfig = function(data) {
	var self = this;
	//Perform your installation tasks here
};

mvesJb.prototype.getConf = function(varName) {
	var self = this;
	//Perform your installation tasks here
};

mvesJb.prototype.setConf = function(varName, varValue) {
	var self = this;
	//Perform your installation tasks here
};


mvesJb.prototype.savePanelColor = function(data){
	
	const self = this;
	
	self.info('Richiesta salvataggio!');
	
	let tmp = {};
	
	tmp['pr'] = parseInt(data['pr']);
	tmp['pg'] = parseInt(data['pg']);
	tmp['pb'] = parseInt(data['pb']);
	
	tmp['sbr'] = parseInt(data['sbr']);
	tmp['sbg'] = parseInt(data['sbg']);
	tmp['sbb'] = parseInt(data['sbb']);
	
	tmp['sbkr'] = parseInt(data['sbkr']);
	tmp['sbkb'] = parseInt(data['sbkb']);
	tmp['sbkg'] = parseInt(data['sbkg']);
	
	self.config.set('pr', tmp['pr']);
	self.config.set('pg', tmp['pg']);
	self.config.set('pb', tmp['pb']);
	
	self.config.set('sbr', tmp['sbr']);
	self.config.set('sbg', tmp['sbg']);
	self.config.set('sbb', tmp['sbb']);
	
	self.config.set('sbkr', tmp['sbkr']);
	self.config.set('sbkb', tmp['sbkb']);
	self.config.set('sbkg', tmp['sbkg']);
	
	self.sendColorConfiguration(tmp);
};

// Playback Controls ---------------------------------------------------------------------------------------
// If your plugin is not a music_sevice don't use this part and delete it


mvesJb.prototype.addToBrowseSources = function () {

	// Use this function to add your music service plugin to music sources
    //var data = {name: 'Spotify', uri: 'spotify',plugin_type:'music_service',plugin_name:'spop'};
    this.commandRouter.volumioAddToBrowseSources(data);
};

mvesJb.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    //self.commandRouter.logger.info(curUri);
    var response;


    return response;
};



// Define a method to clear, add, and play an array of tracks
mvesJb.prototype.clearAddPlayTrack = function(track) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::clearAddPlayTrack');

	self.commandRouter.logger.info(JSON.stringify(track));

	return self.sendSpopCommand('uplay', [track.uri]);
};

mvesJb.prototype.seek = function (timepos) {
    this.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::seek to ' + timepos);

    return this.sendSpopCommand('seek '+timepos, []);
};

// Stop
mvesJb.prototype.stop = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::stop');


};

// Spop pause
mvesJb.prototype.pause = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::pause');


};

// Get state
mvesJb.prototype.getState = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::getState');


};

//Parse state
mvesJb.prototype.parseState = function(sState) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::parseState');

	//Use this method to parse the state and eventually send it with the following function
};

// Announce updated State
mvesJb.prototype.pushState = function(state) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'mvesJb::pushState');

	return self.commandRouter.servicePushState(state, self.servicename);
};


mvesJb.prototype.explodeUri = function(uri) {
	var self = this;
	var defer=libQ.defer();

	// Mandatory: retrieve all info for a given URI

	return defer.promise;
};

mvesJb.prototype.getAlbumArt = function (data, path) {

	var artist, album;

	if (data != undefined && data.path != undefined) {
		path = data.path;
	}

	var web;

	if (data != undefined && data.artist != undefined) {
		artist = data.artist;
		if (data.album != undefined)
			album = data.album;
		else album = data.artist;

		web = '?web=' + nodetools.urlEncode(artist) + '/' + nodetools.urlEncode(album) + '/large'
	}

	var url = '/albumart';

	if (web != undefined)
		url = url + web;

	if (web != undefined && path != undefined)
		url = url + '&';
	else if (path != undefined)
		url = url + '?';

	if (path != undefined)
		url = url + 'path=' + nodetools.urlEncode(path);

	return url;
};

mvesJb.prototype.search = function (query) {
	var self=this;
	var defer=libQ.defer();

	// Mandatory, search. You can divide the search in sections using following functions

	return defer.promise;
};

mvesJb.prototype._searchArtists = function (results) {

};

mvesJb.prototype._searchAlbums = function (results) {

};

mvesJb.prototype._searchPlaylists = function (results) {


};

mvesJb.prototype._searchTracks = function (results) {

};

mvesJb.prototype.goto=function(data){
    var self=this
    var defer=libQ.defer()

// Handle go to artist and go to album function

     return defer.promise;
};



///////////////////////
//MVES JukeBox Metodi
///////////////////////

mvesJb.prototype.startSpectrumAnalyzer = function(){
	const self = this;
	const PROCESS_CHECK_DELAY = 250;
	var errorMessage = "";

	//comando da lanciare
	var command = "cava";

	//avvio 
	self.cavaInstance = exec(command, function(error, stdout, stderr){

		errorMessage = stderr;

		if (stderr)
		{
			self.logger.error(`errore durante l'avvio di CAVA: ${stderr}`);
			self.commandRouter.pushToastMessage("error", "MVES-JB", stderr);
		}
	});

	setTimeout(
		function(){
			if (!errorMessage)
			{
				self.logger.info("CAVA Avviato correttamente!");
				self.commandRouter.pushToastMessage("success", "MVES-JB", "MVES JukeBox Avviato!");

				//avvio il lettore di stream
				try
				{
					self.rl = readline.createInterface({input: self.cavaInstance.stdout});
					self.rl.on('line', (data) => {self.sendSpectrumData(data);});
				}
				catch (excp)
				{
					self.commandRouter.pushToastMessage("error", "MVES-JB", "Errore durante la creazione dello spettro!");

					self.stopSpectrumAnalyzer();
					self.rl = null;
				}
			}
		}, PROCESS_CHECK_DELAY
	);
};

mvesJb.prototype.sendSpectrumData = function (line)
{
	const self = this;

	//processo una riga di spettro
	try
	{
		//invio al controller del pannello
		//self.info(`SPETTRO: ${line}`);

		//invio sulla uart
		let spectrum_json = {};
		let spectrum_str = "";

		spectrum_json['opcode'] = "spectrum";
		spectrum_json['values'] = line;

		spectrum_str = JSON.stringify(spectrum_json) + '\n';

		self.port.write(spectrum_str);
	}
	catch (excp)
	{
		self.info(excp);
	}
};

mvesJb.prototype.sendColorConfiguration = function(color_config)
{
	var self = this;

	//let panelcolor_json = {};
	let colorconfig_str = "";

	color_config['opcode'] = "colors";
	
	colorconfig_str = JSON.stringify(color_config) + '\n';

	self.info(colorconfig_str);

	try
	{
		self.port.write(colorconfig_str);
	}
	catch (excp)
	{
		self.info(excp);
	}
}

mvesJb.prototype.interfaceMessage = function (data)
{
	const self = this;

	//parso gli eventi dal pannello
	let request = "";
	
	try
	{
		request = JSON.parse(data);
	}
	catch(excp)
	{
		self.info(excp);
		
		return;
	}
	
	if ( request['opcode'] === 'volume' )
	{
		let new_vol = parseInt(request['value']);

		if ( new_vol > 100 ) new_vol = 100;
		if ( new_vol <= 10 ) new_vol = 'mute';

		self.info(`Richiesta volume ${new_vol}`);

		//modifico il volume
		self.ioSocket.emit('volume', new_vol);
	}
	else if ( request['opcode'] === 'addQueue' )
	{
		try
		{
			let disc = request['disc'];
			let track = request['track'];
			let force_play = request['force'];
			let qpos = request['qpos'];
			
			if ( qpos === undefined ) qpos = 0;
			
			let base_path = MVES_LIBRARY_PATH;
			let track_filename = path.basename(self.discs[disc.toString()]['tracks'][track-1]);
			let track_vpath = path.join(base_path, disc.toString(), track_filename);

			//avvio o aggiungo in coda la traccia richiesta
			self.info(`Richiesta riproduzione ${disc} - ${track}: ${track_vpath}`);

			self.ioSocket.emit('addToQueue', {'uri': `${track_vpath}`});

			if ( (self.currentStatus == null) || (self.currentStatus['status'] != 'play') || (force_play == 1) )
			{
				self.info('Avvio riproduzione!');
				setTimeout(() => {self.ioSocket.emit('play', {'value': qpos});}, 2000);
			}
		}
		catch(errmsg)
		{
			self.info(errmsg);
		}
	}
	else if ( request['opcode'] === 'jump' )
	{
		try
		{
			let dir = parseInt(request['dir']);
			
			//salto prev o next
			self.info(`Richiesta jump ${dir}`);
			
			if ( dir > 0 )
				self.ioSocket.emit('next');
			else if ( dir < 0 )
				self.ioSocket.emit('prev');
		}
		catch(errmsg)
		{
			self.info(errmsg);
		}
	}
};

mvesJb.prototype.restartSpectrumAnalyzer = function(){
	const self = this;
	self.stopSpectrumAnalyzer(function(){
		self.startSpectrumAnalyzer();
	});
};


mvesJb.prototype.stopSpectrumAnalyzer = function(callback){
	const self = this;
	const killCavaProcess = "/usr/bin/sudo /usr/bin/killall cava";
	
	//uccido cava
	exec(killCavaProcess, function(error, stdout, stderr){
		self.logger.info(`Kill del task CAVA`);
		self.cavaInstance = null;
		
		if (callback && typeof(callback) === "function") {
			callback();
		}
	});
};

mvesJb.prototype.info = function(msg){
	const self = this;
	self.logger.info(`[MVES-JB] ${msg}`);
};
