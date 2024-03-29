(function() {
  var de_obfuscate;

  de_obfuscate = function(_, email) {
    return email.replace("...", "@").replace(/\.\.\./g, ".");
  };

  $(document).ready(function() {
    return $(".eml").each(function() {
      $(this).html(de_obfuscate);
      if ($(this).attr("href")) {
        return $(this).attr("href", de_obfuscate);
      }
    });
  });

}).call(this);
